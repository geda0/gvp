# Build from repository root so COPY can reach resume/ and data/:
#   docker build -f docker/chat/Dockerfile .
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    CHAT_PROVIDER=mock

COPY docker/chat/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY docker/chat/app /app/app
COPY resume/resume.json /app/corpus/resume.json
COPY data/projects.json /app/corpus/projects.json

COPY docker/chat/pytest.ini /app/pytest.ini
COPY docker/chat/tests /app/tests

ENV CORPUS_RESUME_PATH=/app/corpus/resume.json \
    CORPUS_PROJECTS_PATH=/app/corpus/projects.json

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
