#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <cluster> <migration-task-definition> <comma-separated-subnets> <comma-separated-security-groups>" >&2
  exit 64
fi

cluster=$1
task_definition=$2
subnets=$3
security_groups=$4
network_configuration="awsvpcConfiguration={subnets=[$subnets],securityGroups=[$security_groups],assignPublicIp=DISABLED}"

task_arn=$(
  aws ecs run-task \
    --cluster "$cluster" \
    --task-definition "$task_definition" \
    --launch-type FARGATE \
    --network-configuration "$network_configuration" \
    --count 1 \
    --query 'tasks[0].taskArn' \
    --output text
)

if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
  echo "migration release task was not started" >&2
  exit 1
fi

aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"
exit_code=$(
  aws ecs describe-tasks \
    --cluster "$cluster" \
    --tasks "$task_arn" \
    --query 'tasks[0].containers[?name==`migration`].exitCode | [0]' \
    --output text
)

if [ "$exit_code" != "0" ]; then
  aws ecs describe-tasks \
    --cluster "$cluster" \
    --tasks "$task_arn" \
    --query 'tasks[0].{stopCode:stopCode,stoppedReason:stoppedReason,containers:containers[*].{name:name,exitCode:exitCode,reason:reason}}' \
    --output json >&2
  exit 1
fi

echo "migration release task succeeded: $task_arn"
