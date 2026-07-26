_DB: dict[str, dict] = {"u1": {"name": "Alice", "role": "admin"}}

def getAccountInfo(user_id: str) -> dict:
    record = _DB.get(user_id)
    if record is None:
        raise KeyError(f"unknown user {user_id}")
    return record
