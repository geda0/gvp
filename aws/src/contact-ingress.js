import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { createIngressHandler } from './contact-ingress-core.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sqs = new SQSClient({})

const persistMessage = (record) =>
  ddb.send(new PutCommand({
    TableName: process.env.CONTACT_MESSAGES_TABLE,
    Item: record,
    ConditionExpression: 'attribute_not_exists(id)'
  }))

const enqueueDelivery = ({ id, idempotencyKey }) =>
  sqs.send(new SendMessageCommand({
    QueueUrl: process.env.CONTACT_DELIVERY_QUEUE_URL,
    MessageBody: JSON.stringify({ id, idempotencyKey })
  }))

export const handler = createIngressHandler({ persistMessage, enqueueDelivery })
