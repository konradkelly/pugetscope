# PugetScope — Terraform (Phase 1)

Provisions the AWS infra described in [`docs/SPEC.md`](../docs/SPEC.md) §9 Phase 1:
VPC, EC2 instances for future K8s nodes, RDS (Postgres/PostGIS), ElastiCache
(Redis), ECR, and IAM. **This does not bootstrap a Kubernetes cluster** —
`kubeadm init`/`join` is Phase 2, a separate manual/scripted step once these
instances exist.

## Layout

```
terraform/
  bootstrap/     # one-time: creates the S3 state bucket. Own local state.
  modules/
    vpc/               # VPC, public+private subnets (2 AZs), IGW, route tables
    security_groups/   # k8s-nodes / rds / redis security groups
    ecr/                # 4 repos (frontend/api/ingestion/websocket) + lifecycle policy
    rds/                # Postgres, Secrets Manager credential storage
    elasticache/        # single-node Redis
    iam/                 # EC2 instance role + GitHub Actions OIDC role
    ec2/                 # K8s node instances (control-plane + worker)
  main.tf / variables.tf / outputs.tf / versions.tf   # root module, wires it all together
```

## One-time setup

```bash
# 1. Create the S3 state bucket (own local state, run once ever)
cd terraform/bootstrap
terraform init
terraform apply
cd ..

# 2. Init the main config (backend bucket name is already hardcoded in versions.tf)
terraform init

# 3. Review, then apply
cp terraform.tfvars.example terraform.tfvars   # edit as needed — see below
terraform plan
terraform apply
```

## Decisions worth knowing before you `apply`

- **No NAT gateway.** K8s nodes sit in public subnets with direct IGW access
  (locked down by the `k8s_nodes` security group); RDS/ElastiCache sit in
  private subnets with no internet route at all. This is the cost tradeoff
  (~$32/mo NAT gateway avoided) that requires the nodes themselves to be
  internet-facing.
- **No SSH by default.** `admin_cidrs` defaults to `[]`, so port 22 and the
  K8s API (6443) aren't open to anyone. The EC2 instance role includes
  `AmazonSSMManagedInstanceCore`, so use `aws ssm start-session --target
  <instance-id>` (see `terraform output k8s_node_instance_ids`) instead. Set
  `admin_cidrs = ["YOUR.IP/32"]` in `terraform.tfvars` if you want direct SSH.
- **Single-AZ, single-node everywhere** (RDS, Redis, 1 control-plane node by
  default). Same tradeoff SPEC.md §9 makes explicitly for the K8s control
  plane: cheaper and simpler while the fundamentals are still being learned,
  with HA as a deliberate later upgrade, not a default.
- **PostGIS**: RDS Postgres allow-lists it, but Terraform can't run SQL.
  After the DB exists, connect (from a K8s node, once one exists — RDS isn't
  reachable from your laptop) and run:
  ```sql
  CREATE EXTENSION IF NOT EXISTS postgis;
  ```
- **RDS credentials** are generated (`random_password`) and stored in
  Secrets Manager, not in `terraform.tfvars` or plaintext outputs. Retrieve
  with:
  ```bash
  aws secretsmanager get-secret-value --secret-id pugetscope/rds/postgres --query SecretString --output text
  ```
- **Redis has no AUTH/TLS.** It only ever holds latest aircraft positions
  and pub/sub traffic (SPEC.md §7), not secrets, so the client-side TLS
  complexity isn't worth it for v1.
- **EC2 user-data** installs containerd + kubelet/kubeadm/kubectl (OS-level
  prep only) but does not run `kubeadm init`. Node count/sizing:
  `control_plane_count` (default 1) and `worker_count` (default 1), each
  independently sized (`control_plane_instance_type` / `worker_instance_type`).
- **GitHub Actions OIDC role** (`module.iam.github_actions_role_arn`) lets CI
  assume an AWS role without a long-lived access key, scoped to `ec2:*`,
  `rds:*`, `elasticache:*`, `ecr:*`, plus IAM/Secrets Manager/S3 permissions
  narrowed to this project's own resource names — not account-wide admin.

## Estimated cost (us-west-2, 24/7, default sizing)

| Resource | Type | ~$/mo |
|---|---|---|
| EC2 control-plane | 1× t3.medium | ~$30 |
| EC2 worker | 1× t3.small | ~$15 |
| RDS Postgres | db.t4g.micro, 20GB gp3, single-AZ | ~$15 |
| ElastiCache Redis | cache.t4g.micro, single node | ~$12 |
| ECR / S3 / Secrets Manager | — | ~$1–2 |
| **Total** | | **~$70–75/mo** |

No NAT gateway, no Multi-AZ, no load balancer — all removable line items were
removed. Biggest lever if the bill needs to shrink: stop the EC2 instances
(`aws ec2 stop-instances`) between working sessions — RDS/ElastiCache accrue
cost while running regardless of traffic, EC2 doesn't while stopped.

## Teardown

```bash
terraform destroy
```

`skip_final_snapshot = true` on RDS and `recovery_window_in_days = 0` on the
Secrets Manager secret mean a `destroy` is immediate and complete — no
lingering snapshots or pending-deletion secrets to notice and clean up later.
The state bucket itself (`terraform/bootstrap`) has `prevent_destroy = true`
and is not touched by this `destroy`.
