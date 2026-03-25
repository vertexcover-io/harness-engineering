import redis
import json
import threading
from datetime import datetime, timedelta


_sent_log = []  # module-level mutable list tracking all sent notifications


class NotificationService:
    """Sends notifications via email, SMS, or push. Batches when possible."""

    _instance = None

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.redis = redis.Redis(host="notifications-redis", port=6379, db=0)
        self.lock = threading.Lock()

    def send(self, user_id: str, channel: str, message: str, priority: str = "normal") -> dict:
        prefs = json.loads(self.redis.get(f"user:{user_id}:prefs") or "{}")

        if prefs.get("do_not_disturb"):
            quiet_start = prefs.get("dnd_start", "22:00")
            quiet_end = prefs.get("dnd_end", "07:00")
            if self._is_quiet_hours(quiet_start, quiet_end):
                if priority != "critical":
                    self.redis.rpush(f"user:{user_id}:deferred", json.dumps({
                        "channel": channel, "message": message, "queued_at": datetime.now().isoformat()
                    }))
                    return {"status": "deferred", "reason": "quiet_hours"}

        if channel == "email":
            result = self._send_email(user_id, message, prefs)
        elif channel == "sms":
            result = self._send_sms(user_id, message)
        elif channel == "push":
            result = self._send_push(user_id, message)
        else:
            return {"status": "error", "reason": f"unknown channel: {channel}"}

        with self.lock:
            _sent_log.append({
                "user_id": user_id,
                "channel": channel,
                "timestamp": datetime.now().isoformat(),
            })

        return result

    def get_send_count(self, user_id: str) -> int:
        return sum(1 for entry in _sent_log if entry["user_id"] == user_id)

    def flush_deferred(self, user_id: str) -> list[dict]:
        results = []
        while True:
            item = self.redis.lpop(f"user:{user_id}:deferred")
            if item is None:
                break
            data = json.loads(item)
            result = self.send(user_id, data["channel"], data["message"])
            results.append(result)
        return results

    def _is_quiet_hours(self, start: str, end: str) -> bool:
        now = datetime.now().time()
        start_time = datetime.strptime(start, "%H:%M").time()
        end_time = datetime.strptime(end, "%H:%M").time()
        if start_time > end_time:  # overnight range like 22:00 - 07:00
            return now >= start_time or now <= end_time
        return start_time <= now <= end_time

    def _send_email(self, user_id: str, message: str, prefs: dict) -> dict:
        email = prefs.get("email")
        if not email:
            email_data = json.loads(self.redis.get(f"user:{user_id}:profile") or "{}")
            email = email_data.get("email")
        if not email:
            return {"status": "error", "reason": "no email address"}

        # Direct SMTP call buried here
        import smtplib
        server = smtplib.SMTP("smtp.internal.co", 587)
        server.sendmail("notify@app.com", email, f"Subject: Notification\n\n{message}")
        server.quit()
        return {"status": "sent", "channel": "email"}

    def _send_sms(self, user_id: str, message: str) -> dict:
        phone = json.loads(self.redis.get(f"user:{user_id}:profile") or "{}").get("phone")
        if not phone:
            return {"status": "error", "reason": "no phone number"}
        # Twilio API call
        import requests
        resp = requests.post("https://api.twilio.com/send", json={"to": phone, "body": message})
        if resp.status_code != 200:
            return {"status": "error", "reason": "sms_failed"}
        return {"status": "sent", "channel": "sms"}

    def _send_push(self, user_id: str, message: str) -> dict:
        token = self.redis.get(f"user:{user_id}:push_token")
        if not token:
            return {"status": "error", "reason": "no push token"}
        import requests
        resp = requests.post("https://fcm.googleapis.com/send", json={
            "to": token.decode(), "notification": {"body": message}
        })
        return {"status": "sent" if resp.status_code == 200 else "error", "channel": "push"}
