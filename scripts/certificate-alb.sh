# --- IDs verified against your account ---
REGION=us-east-2
ZONE_ID=Z00386331HUYP7Q8OGE1                  # Route53 hosted zone for marwanelgendy.link
DOMAIN=chat-api-stage.marwanelgendy.link
ALB_DNS=gvp-chat-stage-1330484485.us-east-2.elb.amazonaws.com
ALB_HZID=Z3AADJGX6KTTL2                       # ALB canonical hosted zone in us-east-2

# 1) Request ACM cert (DNS-validated)
CERT_ARN=$(aws acm request-certificate --region "$REGION" \
  --domain-name "$DOMAIN" --validation-method DNS \
  --query CertificateArn --output text)
echo "CERT_ARN=$CERT_ARN"

# 2) Read the validation CNAME ACM expects (poll briefly until populated)
for i in 1 2 3 4 5; do
  REC=$(aws acm describe-certificate --region "$REGION" --certificate-arn "$CERT_ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json)
  [ "$REC" != "null" ] && break
  sleep 3
done
REC_NAME=$(echo "$REC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Name"])')
REC_VALUE=$(echo "$REC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Value"])')

# 3) Plant the validation CNAME in Route53
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "{
  \"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{
    \"Name\":\"$REC_NAME\",\"Type\":\"CNAME\",\"TTL\":300,
    \"ResourceRecords\":[{\"Value\":\"$REC_VALUE\"}]}}]}" >/dev/null

# 4) Wait for ACM to flip Issued (usually <2 min once the CNAME lands)
aws acm wait certificate-validated --region "$REGION" --certificate-arn "$CERT_ARN"

# 5) Add the public ALIAS that points $DOMAIN at the ALB
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "{
  \"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{
    \"Name\":\"$DOMAIN\",\"Type\":\"A\",
    \"AliasTarget\":{\"HostedZoneId\":\"$ALB_HZID\",\"DNSName\":\"$ALB_DNS\",\"EvaluateTargetHealth\":false}}}]}" >/dev/null

# 6) Export for the redeploy
echo
echo "Paste these and re-run integrate-and-deploy.sh stage:"
echo "  export CHAT_ECS_CERT_ARN_STAGE=$CERT_ARN"
echo "  export CHAT_STAGE_CHAT_API_URL=https://$DOMAIN/api/chat"