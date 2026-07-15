# K8s node security group. Nodes are in public subnets (see vpc module) so
# this SG is the actual perimeter — it, not subnet placement, is what keeps
# the nodes locked down.
resource "aws_security_group" "k8s_nodes" {
  name_prefix = "${var.project}-k8s-nodes-"
  description = "K8s node instances: SSH/API from admin CIDRs, HTTP(S)+NodePort from the internet, all traffic between nodes"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.project}-k8s-nodes"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# SSH — only opened if var.admin_cidrs is non-empty. SSM Session Manager
# (via the ec2 module's instance profile) is the primary access path, so
# leaving this empty by default is fine, not just theoretical.
resource "aws_security_group_rule" "ssh_from_admin" {
  count             = length(var.admin_cidrs) > 0 ? 1 : 0
  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = var.admin_cidrs
  security_group_id = aws_security_group.k8s_nodes.id
  description       = "SSH from admin CIDRs"
}

resource "aws_security_group_rule" "k8s_api_from_admin" {
  count             = length(var.admin_cidrs) > 0 ? 1 : 0
  type              = "ingress"
  from_port         = 6443
  to_port           = 6443
  protocol          = "tcp"
  cidr_blocks       = var.admin_cidrs
  security_group_id = aws_security_group.k8s_nodes.id
  description       = "Kubernetes API server from admin CIDRs"
}

resource "aws_security_group_rule" "http_from_internet" {
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.k8s_nodes.id
  description       = "HTTP for the public app via ingress"
}

resource "aws_security_group_rule" "https_from_internet" {
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.k8s_nodes.id
  description       = "HTTPS for the public app via ingress"
}

resource "aws_security_group_rule" "nodeport_from_internet" {
  type              = "ingress"
  from_port         = 30000
  to_port           = 32767
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.k8s_nodes.id
  description       = "NodePort range, for nginx-ingress before/without an external LB"
}

# Self-referencing rule: kubelet, etcd, kube-proxy, and the pod-network
# overlay (VXLAN etc.) all need node-to-node traffic on ports that vary by
# CNI choice, so this allows all traffic among nodes in the SG rather than
# enumerating each port.
resource "aws_security_group_rule" "node_to_node" {
  type                     = "ingress"
  from_port                = 0
  to_port                  = 0
  protocol                 = "-1"
  source_security_group_id = aws_security_group.k8s_nodes.id
  security_group_id        = aws_security_group.k8s_nodes.id
  description              = "All traffic between K8s nodes (etcd, kubelet, pod network overlay)"
}

resource "aws_security_group_rule" "nodes_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.k8s_nodes.id
  description       = "Unrestricted egress (image pulls, package installs, OpenSky/adsbdb/AeroDataBox API calls)"
}

resource "aws_security_group" "rds" {
  name_prefix = "${var.project}-rds-"
  description = "RDS Postgres: only reachable from K8s nodes"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.project}-rds"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "rds_from_nodes" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.k8s_nodes.id
  security_group_id        = aws_security_group.rds.id
  description              = "Postgres from K8s nodes"
}

resource "aws_security_group_rule" "rds_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.rds.id
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.project}-redis-"
  description = "ElastiCache Redis: only reachable from K8s nodes"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.project}-redis"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "redis_from_nodes" {
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.k8s_nodes.id
  security_group_id        = aws_security_group.redis.id
  description              = "Redis from K8s nodes"
}

resource "aws_security_group_rule" "redis_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.redis.id
}
