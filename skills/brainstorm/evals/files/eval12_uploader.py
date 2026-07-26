import boto3

_s3 = boto3.client("s3")

def upload_report(bucket: str, key: str, body: bytes) -> str:
    # Fails hard on transient S3 5xx / throttling; callers see raw botocore errors.
    _s3.put_object(Bucket=bucket, Key=key, Body=body)
    return f"s3://{bucket}/{key}"
