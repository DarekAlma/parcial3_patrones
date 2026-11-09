# AegisVolt

Plataforma cloud-native de gestión de carga para flotas eléctricas y electrolineras B2B: reserva de bahías, retención de saldo, activación de carga y telemetría. Se coordina con una SAGA y transacciones compensatorias.

## Estructura

| Ruta | Contenido |
|------|-----------|
| `services/station-reservation-service` | Disponibilidad y bloqueo temporal de bahías |
| `services/billing-wallet-service` | Fondos, cobro y reembolso de la billetera |
| `services/energy-dispatch-service` | Activación del cargador y telemetría |
| `graphql-gateway` | Capa de agregación GraphQL |
| `frontend` | UI web |
| `infra/terraform` | IaC: VPC/VPCE, DynamoDB, API Gateway, EKS, CloudWatch (workspaces dev/test/prod) |
| `k8s` | Manifiestos Kubernetes y canary |
| `prefect` | Flujos de observabilidad |
| `scripts/ci` | Lógica que ejecutan los pipelines |
| `scripts/github` | Configuración reproducible del repo y del runner |

## Entorno

AWS emulado localmente con [Floci](https://github.com/floci-io/floci) en `http://localhost:4566` (región `us-east-1`, credenciales `test`/`test`). No se usa AWS real.

```powershell
docker run --rm -p 4566:4566 -v //var/run/docker.sock:/var/run/docker.sock floci/floci:latest
```

## Gobernanza y CI/CD

Ramas `dev`, `test` y `prod`, con promoción `feature/* -> dev -> test -> prod` solo por PR. Detalle en [docs/GOBERNANZA-GIT.md](docs/GOBERNANZA-GIT.md).
