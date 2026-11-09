output "state_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}

output "state_bucket_versioning" {
  value = aws_s3_bucket_versioning.tfstate.versioning_configuration[0].status
}
