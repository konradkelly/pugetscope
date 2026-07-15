# PugetScope — Terraform (Phase 1 + domain)

Provisions the AWS infra described in [`docs/SPEC.md`](../docs/SPEC.md) §9 Phase 1:
VPC, EC2 instances for K8s nodes, RDS (Postgres/PostGIS), ElastiCache
(Redis), ECR, IAM, plus (added after Phase 2's cluster bootstrap) a stable
Elastic IP and a Route 53 hosted zone for pugetscope.com. Kubernetes itself
(kubeadm, Flannel, ingress-nginx, cert-manager) is not Terraform-managed —
see `k8s/README.md`'s "EC2 cluster" section for that layer.

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
    ec2/                 # K8s node instances (control-plane + worker) + Elastic IP
    route53/             # Hosted zone + apex A record for pugetscope.com
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
- **GitHub Actions OIDC provider is looked up, not created.** This AWS
  account already had one (from another project) — `modules/iam` uses a data
  source (`data.aws_iam_openid_connect_provider`) rather than creating a
  second one, since the provider is a singleton per issuer URL per account.
- **Elastic IP** (`module.ec2.aws_eip.ingress`) is attached to the
  control-plane instance specifically, but functionally it doesn't matter
  which node holds it — ingress-nginx is a NodePort Service, and kube-proxy
  forwards traffic hitting *any* node's NodePort to the right pod regardless
  of which node it's actually running on. Solves two problems: DNS needs a
  stable IP, and a node's own `public_ip` changes on stop/start.
- **Route 53 hosted zone** for `pugetscope.com` — Hostinger stays the
  registrar (domain purchase), but nameservers there are pointed at this
  zone's 4 `name_servers` (a manual one-time step at Hostinger, not
  Terraform-reachable). `terraform output route53_name_servers` to get them
  again.
- **ECR tags are mutable**, not immutable. `k8s/push-ecr.sh` and the local
  k3d workflow both push a floating tag (`ec2-latest` / `latest`) on every
  build — immutable tags blocked re-pushing on redeploy (hit this directly:
  the first EC2 deploy failed with "tag ... cannot be overwritten"). Related
  gotcha that bit us even after fixing this: Kubernetes only defaults
  `imagePullPolicy` to `Always` for the *literal* tag `latest` — `ec2-latest`
  doesn't qualify, so the Deployments explicitly set
  `imagePullPolicy: Always` (`k8s/base/*-deployment.yaml`) to force a real
  re-pull on every redeploy instead of silently reusing a stale cached image.
- **A `terraform plan` here will currently show 2 pending instance
  replacements** (`aws_instance.node["control-plane-1"/"worker-1"] must be
  replaced`) — `terraform/modules/ec2/templates/node-init.sh.tpl` was fixed
  to install `conntrack`/`ebtables`/`socat` (a kubeadm preflight dependency
  missing on first boot) after the live cluster was already bootstrapped.
  Applying it now would destroy and recreate both running nodes via
  `user_data_replace_on_change = true`, wiping the live kubeadm cluster —
  deliberately **not applied**. It'll take effect cleanly on the next
  intentional node rebuild (e.g. the Phase 3 HA milestone). If you need to
  apply unrelated changes in the meantime, use `-target` to avoid sweeping
  these two instances in (see git history around the EIP/Route53 addition
  for the exact pattern).

## Estimated cost (us-west-2, 24/7, default sizing)

| Resource | Type | ~$/mo |
|---|---|---|
| EC2 control-plane | 1× t3.medium | ~$30 |
| EC2 worker | 1× t3.small | ~$15 |
| RDS Postgres | db.t4g.micro, 20GB gp3, single-AZ | ~$15 |
| ElastiCache Redis | cache.t4g.micro, single node | ~$12 |
| Elastic IP | attached to a running instance | $0 |
| Route 53 hosted zone | + negligible query volume | ~$0.50 |
| ECR / S3 / Secrets Manager | — | ~$1–2 |
| **Total** | | **~$70–75/mo** |

No NAT gateway, no Multi-AZ, no load balancer — all removable line items were
removed. Biggest lever if the bill needs to shrink: stop the EC2 instances
(`aws ec2 stop-instances`) between working sessions — RDS/ElastiCache accrue
cost while running regardless of traffic, EC2 doesn't while stopped. One
nuance the Elastic IP adds: AWS only waives its ~$0.005/hr charge while the
IP is attached to a **running** instance — stopping the control-plane node
to save cost starts a small EIP charge (~$3.6/mo if left stopped a full
month) until it's started again or the EIP is released.

## Teardown

```bash
terraform destroy
```

`skip_final_snapshot = true` on RDS and `recovery_window_in_days = 0` on the
Secrets Manager secret mean a `destroy` is immediate and complete — no
lingering snapshots or pending-deletion secrets to notice and clean up later.
The state bucket itself (`terraform/bootstrap`) has `prevent_destroy = true`
and is not touched by this `destroy`.
