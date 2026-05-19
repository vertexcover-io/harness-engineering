# Design Doc: File Upload with Virus Scanning

**Status:** Approved
**Date:** 2026-03-22
**Author:** Marcus Lee

## Context

Users need to upload documents (PDF, DOCX, images) to attach to support tickets. Currently there is no upload capability. We need a secure upload pipeline that scans files for malware before making them available.

## Proposed Solution

### Upload Flow

1. Client requests a pre-signed upload URL from the API
2. Client uploads the file directly to object storage (S3) using the pre-signed URL
3. An S3 event triggers a Lambda function that submits the file to the virus scanner
4. The scanner processes the file and updates the file record status
5. If clean, the file is moved from the quarantine bucket to the public bucket and linked to the ticket
6. If infected, the file is deleted and the user is notified

### File Validation

Before generating the pre-signed URL, the API validates:
- File extension is in the allowlist: pdf, docx, doc, png, jpg, jpeg, gif
- Declared content type matches the extension
- Declared file size is under 25MB

After upload, the system also validates:
- Actual file size matches the declared size (within 1% tolerance)
- Magic bytes match the declared content type (prevents extension spoofing)

### Virus Scanning

- Use ClamAV running as a sidecar service
- Scan timeout: 60 seconds per file
- If scan times out, the file stays in quarantine and an alert is raised for manual review
- Scanner updates are pulled daily from the ClamAV mirror
- Files remain in quarantine status until scan completes

### Status Tracking

Each file has a status lifecycle:
- `pending_upload` - pre-signed URL generated, waiting for upload
- `uploading` - multipart upload in progress
- `pending_scan` - uploaded, queued for virus scan
- `scanning` - virus scan in progress
- `clean` - scan passed, file available
- `infected` - malware detected, file quarantined
- `scan_timeout` - scan exceeded 60 seconds, needs manual review
- `rejected` - validation failed (wrong type, too large, size mismatch)

### Access Control

- Only the ticket creator and assigned support agents can view attachments
- Pre-signed download URLs expire after 15 minutes
- Files are encrypted at rest using AES-256
- Audit log records every file access (who, when, which file)

## Constraints

- Maximum 5 files per ticket
- Maximum 25MB per file, 100MB total per ticket
- Pre-signed upload URLs expire after 10 minutes
- Must support resumable uploads for files over 5MB
- Files must not be accessible until virus scan passes
