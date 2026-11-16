#!/bin/sh
cd "$(dirname "$0")" || exit 1
python3 -m pip install -r requirements.txt || exit 1
python3 -m uvicorn server:app --host 0.0.0.0 --port 8000
