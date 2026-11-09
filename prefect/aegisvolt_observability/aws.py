"""Clientes AWS (boto3) apuntando a Floci y descubrimiento de recursos por ambiente."""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Optional

import boto3
from botocore.config import Config

ENVIRONMENTS = ["dev", "test", "prod"]
PROJECT = os.getenv("PROJECT", "aegisvolt")
REGION = os.getenv("AWS_REGION", "us-east-1")
# Dentro de la red Docker "aegisvolt" Floci es http://floci:4566. NO es AWS real.
ENDPOINT = os.getenv("AWS_ENDPOINT_URL", "http://localhost:4566")

_cfg = Config(retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=15)


@lru_cache(maxsize=None)
def client(service: str):
    return boto3.client(
        service,
        region_name=REGION,
        endpoint_url=ENDPOINT,
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY", "test"),
        config=_cfg,
    )


def table(resource: str, env: str) -> str:
    """Convencion de Terraform: <project>-<recurso>-<ambiente>."""
    return f"{PROJECT}-{resource}-{env}"


def public_api_id(env: str) -> Optional[str]:
    for api in client("apigatewayv2").get_apis().get("Items", []):
        if api.get("Name") == f"{PROJECT}-{env}":
            return api["ApiId"]
    return None


def private_api_id(env: str) -> Optional[str]:
    for api in client("apigateway").get_rest_apis().get("items", []):
        if api.get("name") == f"{PROJECT}-{env}-internal":
            return api["id"]
    return None


def public_api_url(env: str) -> Optional[str]:
    """URL de invocacion de la HTTP API ($default) a traves de Floci."""
    api_id = public_api_id(env)
    return f"{ENDPOINT}/execute-api/{api_id}/$default" if api_id else None


def private_api_url(env: str) -> Optional[str]:
    """URL de la REST API PRIVADA (stage = ambiente). En AWS real solo es alcanzable via el VPCE execute-api."""
    api_id = private_api_id(env)
    return f"{ENDPOINT}/execute-api/{api_id}/{env}" if api_id else None


def scan_all(table_name: str, **kwargs) -> list[dict]:
    items: list[dict] = []
    paginator = client("dynamodb").get_paginator("scan")
    for page in paginator.paginate(TableName=table_name, **kwargs):
        items.extend(page.get("Items", []))
    return items
