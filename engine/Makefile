PY   ?= .venv/bin/python
PORT ?= 8000

.PHONY: install test test-live reset serve demo

install:     ## Python 3.11 venv + dependencies
	uv venv --python 3.11 .venv
	uv pip install --python $(PY) -r requirements.txt

test:        ## A1-A7, offline
	$(PY) -m pytest -q

test-live:   ## the 4 prose samples through OpenAI (needs OPENAI_API_KEY)
	$(PY) -m pytest -q -m live

reset:       ## empty var/, then yesterday's two changes in the feed. Restart the server after.
	$(PY) -m radius.service reset

serve:       ## the API on :8000
	$(PY) -m uvicorn radius.api:app --port $(PORT)

demo:        ## page 31, beat by beat (resets var/)
	$(PY) demo.py
