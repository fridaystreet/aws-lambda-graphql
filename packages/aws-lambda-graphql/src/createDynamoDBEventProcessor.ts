import { DynamoDBStreamHandler } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { ExecutionResult, GraphQLSchema } from 'graphql';
import {
  createAsyncIterator,
  getAsyncIterator,
  isAsyncIterable,
} from 'iterall';
import { formatMessage } from './formatMessage';
import { execute, ExecuteOptions } from './execute';
import {
  IConnectionManager,
  ISubscriptionEvent,
  ISubscriptionManager,
} from './types';
import { getProtocol } from './protocol/getProtocol';

interface DynamoDBEventProcessorOptions {
  connectionManager: IConnectionManager;
  context?: ExecuteOptions['context'];
  schema: GraphQLSchema;
  subscriptionManager: ISubscriptionManager;
}

class PubSub {
  private events: ISubscriptionEvent[];

  constructor(events: ISubscriptionEvent[]) {
    this.events = events;
  }

  asyncIterator(eventNames: string | string[]) {
    const names = Array.isArray(eventNames) ? eventNames : [eventNames];

    return createAsyncIterator(
      this.events
        .filter(event => names.includes(event.event))
        .map(event =>
          typeof event.payload === 'string'
            ? JSON.parse(event.payload)
            : event.payload,
        ),
    );
  }
}

// polyfill Symbol.asyncIterator
if (Symbol.asyncIterator === undefined) {
  (Symbol as any).asyncIterator = Symbol.for('asyncIterator');
}

function createDynamoDBEventProcessor({
  connectionManager,
  context,
  schema,
  subscriptionManager,
}: DynamoDBEventProcessorOptions): DynamoDBStreamHandler {
  return async function processDynamoDBStreamEvents(
    { Records },
    lambdaContext,
  ) {
    for (const record of Records) {
      // process only INSERT events
      if (record.eventName !== 'INSERT') {
        continue;
      }

      // now construct event from dynamodb image
      const event: ISubscriptionEvent = DynamoDB.Converter.unmarshall(
        record.dynamodb!.NewImage as any,
      ) as any;

      // iterate over subscribers that listen to this event
      // and for each connection:
      //  - create a schema (so we have subscribers registered in PubSub)
      //  - execute operation from event againt schema
      //  - if iterator returns a result, send it to client
      //  - clean up subscriptions and follow with next page of subscriptions
      //  - if the are no more subscriptions, process next event
      // make sure that you won't throw any errors otherwise dynamo will call
      // handler with same events again
      for await (const subscribers of subscriptionManager.subscribersByEventName(
        event.event,
      )) {
        const promises = subscribers
          .map(async subscriber => {
            // create PubSub for this subscriber
            const pubSub = new PubSub([event]);

            // execute operation by executing it and then publishing the event
            const iterable = await execute({
              connectionManager,
              subscriptionManager,
              schema,
              event: {} as any, // we don't have an API GW event here
              lambdaContext,
              context,
              connection: subscriber.connection,
              operation: subscriber.operation,
              pubSub: pubSub as any,
              registerSubscriptions: false,
              useSubscriptions: true,
            });

            if (!isAsyncIterable(iterable)) {
              // something went wrong, probably there is an error
              return Promise.resolve();
            }

            const iterator = getAsyncIterator(iterable);
            const result: IteratorResult<ExecutionResult> = await iterator.next();

            if (result.value != null) {
              const { useLegacyProtocol = false } = subscriber.connection.data;
              const { SERVER_EVENT_TYPES } = getProtocol(useLegacyProtocol);
              return connectionManager.sendToConnection(
                subscriber.connection,
                formatMessage({
                  id: subscriber.operationId,
                  payload: result.value,
                  type: SERVER_EVENT_TYPES.GQL_DATA,
                }),
              );
            }

            return Promise.resolve();
          })
          .map(promise => promise.catch(e => console.log(e)));

        await Promise.all(promises);
      }
    }
  };
}

export { createDynamoDBEventProcessor };
export default createDynamoDBEventProcessor;
