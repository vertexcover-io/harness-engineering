from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class AlertRule:
    id: str
    name: str
    metric: str
    threshold: float
    channel: str
    created_at: datetime = field(default_factory=datetime.utcnow)

class AlertEngine:
    def __init__(self, rules: list[AlertRule]):
        self.rules = rules

    def evaluate(self, metric: str, value: float) -> list[AlertRule]:
        return [r for r in self.rules if r.metric == metric and value >= r.threshold]

    def fire(self, rule: AlertRule, value: float) -> None:
        notify(rule.channel, f"{rule.name}: {value} >= {rule.threshold}")

def notify(channel: str, message: str) -> None:
    ...
