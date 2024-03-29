import { Kafka as KafkaJS, Consumer, ConsumerConfig, KafkaConfig, KafkaMessage } from "kafkajs";
import { DBOSContext } from "..";
import { ClassRegistration, MethodRegistration, RegistrationDefaults, getOrCreateClassRegistration, registerAndWrapFunction } from "../decorators";
import { DBOSExecutor } from "../dbos-executor";
import { Transaction } from "../transaction";
import { Workflow } from "../workflow";
import { DBOSError } from "../error";

type KafkaArgs = [string, number, KafkaMessage]

/////////////////////////////
/* Kafka Method Decorators */
/////////////////////////////

export class KafkaRegistration<This, Args extends unknown[], Return> extends MethodRegistration<This, Args, Return> {
  kafkaTopic?: string;
  consumerConfig?: ConsumerConfig;

  constructor(origFunc: (this: This, ...args: Args) => Promise<Return>) {
    super(origFunc);
  }
}

export function KafkaConsume(topic: string, consumerConfig?: ConsumerConfig) {
  function kafkadec<This, Ctx extends DBOSContext, Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: Ctx, ...args: KafkaArgs) => Promise<Return>>
  ) {
    const { descriptor, registration } = registerAndWrapFunction(target, propertyKey, inDescriptor);
    const kafkaRegistration = registration as unknown as KafkaRegistration<This, KafkaArgs, Return>;
    kafkaRegistration.kafkaTopic = topic;
    kafkaRegistration.consumerConfig = consumerConfig;

    return descriptor;
  }
  return kafkadec;
}

/////////////////////////////
/* Kafka Class Decorators  */
/////////////////////////////

export interface KafkaDefaults extends RegistrationDefaults {
  kafkaConfig?: KafkaConfig;
}

export class KafkaClassRegistration<CT extends { new(...args: unknown[]): object }> extends ClassRegistration<CT> implements KafkaDefaults {
  kafkaConfig?: KafkaConfig;

  constructor(ctor: CT) {
    super(ctor);
  }
}

export function Kafka(kafkaConfig: KafkaConfig) {
  function clsdec<T extends { new(...args: unknown[]): object }>(ctor: T) {
    const clsreg = getOrCreateClassRegistration(ctor) as KafkaClassRegistration<T>;
    clsreg.kafkaConfig = kafkaConfig;
  }
  return clsdec;
}

////////////////////////
/* Kafka Management  */
///////////////////////

export class DBOSKafka{
  readonly consumers: Consumer[] = [];

  constructor(readonly dbosExec: DBOSExecutor) {}

  async initKafka() {
    for (const registeredOperation of this.dbosExec.registeredOperations) {
      const ro = registeredOperation as KafkaRegistration<unknown, unknown[], unknown>;
      if (ro.kafkaTopic) {
        const defaults = ro.defaults as KafkaDefaults;
        if (!ro.txnConfig && !ro.workflowConfig) {
          throw new DBOSError(`Error registering method ${defaults.name}.${ro.name}: A Kafka decorator can only be assigned to a transaction or workflow!`)
        }
        if (!defaults.kafkaConfig) {
          throw new DBOSError(`Error registering method ${defaults.name}.${ro.name}: Kafka configuration not found. Does class ${defaults.name} have an @Kafka decorator?`)
        }
        const kafka = new KafkaJS(defaults.kafkaConfig);
        const consumerConfig = ro.consumerConfig ?? { groupId: `dbos-kafka-group-${ro.kafkaTopic}`}
        const consumer = kafka.consumer(consumerConfig);
        await consumer.connect()
        await consumer.subscribe({topic: ro.kafkaTopic, fromBeginning: true})
        await consumer.run({
          eachMessage: async ({ topic, partition, message }) => {
            // This combination uniquely identifies a message for a given Kafka cluster
            const workflowUUID = `kafka-unique-id-${topic}-${partition}-${message.offset}`
            const wfParams = { workflowUUID: workflowUUID };
            // All operations annotated with Kafka decorators must take in these three arguments
            const args: KafkaArgs = [topic, partition, message]
            // We can only guarantee exactly-once-per-message execution of transactions and workflows.
            if (ro.txnConfig) {
              // Execute the transaction
              await this.dbosExec.transaction(ro.registeredFunction as Transaction<unknown[], unknown>, wfParams, ...args);
            } else if (ro.workflowConfig) {
              // Safely start the workflow
              await this.dbosExec.workflow(ro.registeredFunction as Workflow<unknown[], unknown>, wfParams, ...args);
            }
          },
        })
        this.consumers.push(consumer);
      }
    }
  }

  async destroyKafka() {
    for (const consumer of this.consumers) {
      await consumer.disconnect();
    }
  }
}
