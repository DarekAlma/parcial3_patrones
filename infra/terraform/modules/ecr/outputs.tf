output "repository_urls" {
  value = { for svc, repo in aws_ecr_repository.service : svc => repo.repository_url }
}
