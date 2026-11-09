"""Print a fresh Google Calendar access token from gcalcli's stored OAuth login.

Run with gcalcli's own interpreter (it has google-auth installed), e.g.
  /opt/homebrew/Cellar/gcalcli/<ver>/libexec/bin/python -I gcal_token.py

Why: gcalcli `add` cannot set an event's status, transparency, reminders or
private extended properties, which EventScout holds need. CalendarApi.ts calls
the Calendar REST API directly and gets its token from here, so there is one
Google login (gcalcli's), not two. The token goes to stdout only; nothing is
written to disk except gcalcli's own refreshed credential.
"""
import os
import pickle
import sys

from google.auth.transport.requests import Request

PATH = os.path.expanduser("~/Library/Application Support/gcalcli/oauth")

try:
    with open(PATH, "rb") as f:
        creds = pickle.load(f)
    if not creds.valid:
        creds.refresh(Request())
        # Atomic: a kill mid-write must never leave gcalcli's login corrupt.
        tmp = f"{PATH}.eventscout-tmp"
        with open(tmp, "wb") as f:
            pickle.dump(creds, f)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, PATH)
    if "https://www.googleapis.com/auth/calendar" not in (creds.scopes or []):
        raise RuntimeError(f"gcalcli login lacks the calendar scope: {creds.scopes}")
    sys.stdout.write(creds.token)
except Exception as err:  # loud: the caller turns this into an Error
    sys.stderr.write(f"gcal_token: {type(err).__name__}: {err}\n")
    sys.exit(1)
