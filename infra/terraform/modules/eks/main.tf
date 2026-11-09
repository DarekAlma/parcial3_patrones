# =============================================================================
# MODULO EKS - un cluster Kubernetes por ambiente (aegisvolt-<env>)
#
#  - Control plane y node group en subredes PRIVADAS.
#  - Endpoint privado habilitado (los nodos hablan con el API server dentro de
#    la VPC). El endpoint publico queda restringido a public_access_cidrs para
#    que el runner de CI pueda ejecutar kubectl.
#  - EKS Pod Identity: cada microservicio (ServiceAccount) recibe un rol IAM
#    propio con permisos SOLO sobre su tabla DynamoDB => Database-per-Service
#    reforzado por IAM, no solo por convencion.
#  - Logs del control plane (api, audit) a CloudWatch.
#
# En Floci cada cluster es un contenedor k3s real (rancher/k3s).
# =============================================================================

data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "pod_identity_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------
# IAM: control plane y nodos
# ---------------------------------------------------------------------------
resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-node-role"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------
resource "aws_security_group" "cluster" {
  name        = "${var.name}-sg-cluster"
  description = "Control plane EKS"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-sg-cluster" })
}

resource "aws_security_group" "nodes" {
  name        = "${var.name}-sg-nodes"
  description = "Nodos EKS: NodePorts solo desde la VPC (NLB interno / VPC Link)"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-sg-nodes" })
}

resource "aws_vpc_security_group_ingress_rule" "nodes_nodeport_from_vpc" {
  security_group_id = aws_security_group.nodes.id
  description       = "NodePorts desde la VPC (NLB interno)"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 30000
  to_port           = 32767
}

resource "aws_vpc_security_group_ingress_rule" "nodes_self" {
  security_group_id            = aws_security_group.nodes.id
  description                  = "Trafico pod-a-pod entre nodos"
  referenced_security_group_id = aws_security_group.nodes.id
  ip_protocol                  = "-1"
  # Floci devuelve el SG referenciado como "<account>/sg-xxxx" (formato de
  # referencia cross-account) y el provider lo ve como drift perpetuo.
  # En AWS real esta linea es innecesaria.
  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_vpc_security_group_ingress_rule" "nodes_from_cluster" {
  security_group_id            = aws_security_group.nodes.id
  description                  = "Kubelet desde el control plane"
  referenced_security_group_id = aws_security_group.cluster.id
  ip_protocol                  = "tcp"
  from_port                    = 10250
  to_port                      = 10250
  # Floci devuelve el SG referenciado como "<account>/sg-xxxx" (formato de
  # referencia cross-account) y el provider lo ve como drift perpetuo.
  # En AWS real esta linea es innecesaria.
  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_vpc_security_group_ingress_rule" "cluster_from_nodes" {
  security_group_id            = aws_security_group.cluster.id
  description                  = "API server desde los nodos"
  referenced_security_group_id = aws_security_group.nodes.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  # Floci devuelve el SG referenciado como "<account>/sg-xxxx" (formato de
  # referencia cross-account) y el provider lo ve como drift perpetuo.
  # En AWS real esta linea es innecesaria.
  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_vpc_security_group_egress_rule" "nodes_to_vpc" {
  security_group_id = aws_security_group.nodes.id
  description       = "Salida solo dentro de la VPC (VPCE, API server, pods)"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "nodes_to_gateway_endpoints" {
  for_each          = var.gateway_endpoint_prefix_list_ids
  security_group_id = aws_security_group.nodes.id
  description       = "HTTPS hacia Gateway VPCE ${each.key}"
  prefix_list_id    = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "cluster_to_vpc" {
  security_group_id = aws_security_group.cluster.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "-1"
}

# ---------------------------------------------------------------------------
# Cluster y node group
# ---------------------------------------------------------------------------
resource "aws_eks_cluster" "this" {
  name     = var.name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version
  tags     = var.tags

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    security_group_ids      = [aws_security_group.cluster.id]
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.public_access_cidrs
  }

  access_config {
    authentication_mode                         = "API_AND_CONFIG_MAP"
    bootstrap_cluster_creator_admin_permissions = true
  }

  kubernetes_network_config {
    service_ipv4_cidr = var.service_ipv4_cidr
  }

  enabled_cluster_log_types = ["api", "audit"]

  depends_on = [aws_iam_role_policy_attachment.cluster]
}

resource "aws_eks_node_group" "default" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-default"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids
  instance_types  = var.node_instance_types
  capacity_type   = "ON_DEMAND"
  ami_type        = "AL2023_x86_64_STANDARD"
  tags            = var.tags

  labels = {
    "aegisvolt.io/environment" = var.environment
  }

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  depends_on = [aws_iam_role_policy_attachment.node]
}

resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "eks-pod-identity-agent"
  tags         = var.tags
}

# ---------------------------------------------------------------------------
# EKS Pod Identity: rol IAM por microservicio (least privilege)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "workload" {
  for_each           = var.workloads
  name               = "${var.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_assume.json
  tags               = merge(var.tags, { Service = each.key })
}

data "aws_iam_policy_document" "workload" {
  for_each = var.workloads

  statement {
    sid = "OwnTablesOnly"
    actions = [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
      "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem", "dynamodb:TransactWriteItems", "dynamodb:DescribeTable",
    ]
    resources = flatten([for arn in each.value.dynamodb_table_arns : [arn, "${arn}/index/*"]])
  }

  dynamic "statement" {
    for_each = length(each.value.read_only_table_arns) > 0 ? [1] : []
    content {
      sid       = "ReadOnlyTables"
      actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:DescribeTable"]
      resources = each.value.read_only_table_arns
    }
  }

  statement {
    sid       = "OwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${each.value.log_group_arn}:*"]
  }
}

resource "aws_iam_role_policy" "workload" {
  for_each = var.workloads
  name     = "${each.key}-least-privilege"
  role     = aws_iam_role.workload[each.key].id
  policy   = data.aws_iam_policy_document.workload[each.key].json
}

resource "aws_eks_pod_identity_association" "workload" {
  for_each        = var.workloads
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.workload_namespace
  service_account = each.key
  role_arn        = aws_iam_role.workload[each.key].arn
  tags            = var.tags

  depends_on = [aws_eks_addon.pod_identity_agent]
}
