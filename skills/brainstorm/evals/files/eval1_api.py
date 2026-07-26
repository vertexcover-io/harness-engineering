from eval1_service import getAccountInfo

def handle_user_request(user_id: str) -> dict:
    data = getAccountInfo(user_id)
    return {"status": "ok", "user": data}
