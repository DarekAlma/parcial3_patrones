# Worker de observabilidad: publica y ejecuta los flows programados (prefect serve).
FROM prefecthq/prefect:3.1.15-python3.11
WORKDIR /opt/aegisvolt
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY aegisvolt_observability aegisvolt_observability
CMD ["python", "-m", "aegisvolt_observability.serve"]
