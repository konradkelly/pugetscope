# CascadeSec v3 test fixture -- deliberately misconfigured. This PR is a test
# of the CascadeSec GitHub App and will be closed without merging.

resource "aws_s3_bucket" "test_artifacts" {
  bucket = "pugetscope-cascadesec-test-artifacts"
}

resource "aws_security_group" "test_bastion" {
  name        = "cascadesec-test-bastion"
  description = "Test bastion"

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ebs_volume" "test_data" {
  availability_zone = "us-west-2a"
  size              = 10
  encrypted         = false
}
