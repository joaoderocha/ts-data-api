import * as h3 from "h3";
import {
  type ClientSession,
  type Collection,
  type Document,
  type TransactionOptions,
} from "mongodb";
import { z } from "zod";

import { bodyHandler } from "../../middlewares";
import { dataSources } from "../../mdb";
import { DataSourcesNamesSchema } from "../defaults/utils";

const openRecordSchema = z.record(z.unknown());
const updateSchema = z.union([openRecordSchema, z.array(z.record(z.unknown()))]);
const operationTargetShape = {
  database: z.string().min(1),
  collection: z.string().min(1),
  options: openRecordSchema.optional(),
};

const aggregateOperationSchema = z
  .object({
    operation: z.literal("aggregate"),
    ...operationTargetShape,
    pipeline: z.array(openRecordSchema),
  })
  .strict();

const countDocumentsOperationSchema = z
  .object({
    operation: z.literal("countDocuments"),
    ...operationTargetShape,
    filter: openRecordSchema.optional(),
  })
  .strict();

const distinctOperationSchema = z
  .object({
    operation: z.literal("distinct"),
    ...operationTargetShape,
    key: z.string(),
    filter: openRecordSchema.optional(),
  })
  .strict();

const findOperationSchema = z
  .object({
    operation: z.literal("find"),
    ...operationTargetShape,
    filter: openRecordSchema,
  })
  .strict();

const findOneOperationSchema = z
  .object({
    operation: z.literal("findOne"),
    ...operationTargetShape,
    filter: openRecordSchema,
  })
  .strict();

const insertOneOperationSchema = z
  .object({
    operation: z.literal("insertOne"),
    ...operationTargetShape,
    document: openRecordSchema,
  })
  .strict();

const insertManyOperationSchema = z
  .object({
    operation: z.literal("insertMany"),
    ...operationTargetShape,
    documents: z.array(openRecordSchema),
  })
  .strict();

const updateOneOperationSchema = z
  .object({
    operation: z.literal("updateOne"),
    ...operationTargetShape,
    filter: openRecordSchema,
    update: updateSchema,
  })
  .strict();

const updateManyOperationSchema = z
  .object({
    operation: z.literal("updateMany"),
    ...operationTargetShape,
    filter: openRecordSchema,
    update: updateSchema,
  })
  .strict();

const replaceOneOperationSchema = z
  .object({
    operation: z.literal("replaceOne"),
    ...operationTargetShape,
    filter: openRecordSchema,
    replacement: openRecordSchema,
  })
  .strict();

const deleteOneOperationSchema = z
  .object({
    operation: z.literal("deleteOne"),
    ...operationTargetShape,
    filter: openRecordSchema,
  })
  .strict();

const deleteManyOperationSchema = z
  .object({
    operation: z.literal("deleteMany"),
    ...operationTargetShape,
    filter: openRecordSchema,
  })
  .strict();

const findOneAndUpdateOperationSchema = z
  .object({
    operation: z.literal("findOneAndUpdate"),
    ...operationTargetShape,
    filter: openRecordSchema,
    update: updateSchema,
  })
  .strict();

const findOneAndReplaceOperationSchema = z
  .object({
    operation: z.literal("findOneAndReplace"),
    ...operationTargetShape,
    filter: openRecordSchema,
    replacement: openRecordSchema,
  })
  .strict();

const findOneAndDeleteOperationSchema = z
  .object({
    operation: z.literal("findOneAndDelete"),
    ...operationTargetShape,
    filter: openRecordSchema,
  })
  .strict();

export const operationSchema = z.discriminatedUnion("operation", [
  aggregateOperationSchema,
  countDocumentsOperationSchema,
  distinctOperationSchema,
  findOperationSchema,
  findOneOperationSchema,
  insertOneOperationSchema,
  insertManyOperationSchema,
  updateOneOperationSchema,
  updateManyOperationSchema,
  replaceOneOperationSchema,
  deleteOneOperationSchema,
  deleteManyOperationSchema,
  findOneAndUpdateOperationSchema,
  findOneAndReplaceOperationSchema,
  findOneAndDeleteOperationSchema,
]);

export const schema = z
  .object({
    dataSource: DataSourcesNamesSchema,
    operations: z.array(operationSchema).min(1),
    transactionOptions: openRecordSchema.optional(),
  })
  .strict();

type TransactionOperation = z.infer<typeof operationSchema>;

interface OperationResult {
  index: number;
  operation: TransactionOperation["operation"];
  result: unknown;
}

export interface TransactionResponse {
  status: "committed";
  results: OperationResult[];
}

const executeOperation = async (
  collection: Collection<Document>,
  operation: TransactionOperation,
  session: ClientSession,
): Promise<unknown> => {
  const effectiveOptions = { ...operation.options, session };

  switch (operation.operation) {
    case "aggregate":
      return collection.aggregate(operation.pipeline, effectiveOptions).toArray();
    case "countDocuments":
      return collection.countDocuments(operation.filter, effectiveOptions);
    case "distinct":
      return collection.distinct(operation.key, operation.filter ?? {}, effectiveOptions);
    case "find":
      return collection.find(operation.filter, effectiveOptions).toArray();
    case "findOne":
      return collection.findOne(operation.filter, effectiveOptions);
    case "insertOne":
      return collection.insertOne(operation.document, effectiveOptions);
    case "insertMany":
      return collection.insertMany(operation.documents, effectiveOptions);
    case "updateOne":
      return collection.updateOne(operation.filter, operation.update, effectiveOptions);
    case "updateMany":
      return collection.updateMany(operation.filter, operation.update, effectiveOptions);
    case "replaceOne":
      return collection.replaceOne(operation.filter, operation.replacement, effectiveOptions);
    case "deleteOne":
      return collection.deleteOne(operation.filter, effectiveOptions);
    case "deleteMany":
      return collection.deleteMany(operation.filter, effectiveOptions);
    case "findOneAndUpdate":
      return collection.findOneAndUpdate(operation.filter, operation.update, effectiveOptions);
    case "findOneAndReplace":
      return collection.findOneAndReplace(
        operation.filter,
        operation.replacement,
        effectiveOptions,
      );
    case "findOneAndDelete":
      return collection.findOneAndDelete(operation.filter, effectiveOptions);
  }
};

export const method = "post";
export const endPoint = "/custom/transaction";
export const handler = async (event: h3.H3Event) => {
  const body = await bodyHandler({ event, schema });
  const client = dataSources[body.dataSource];
  const session = client.startSession();
  let results: OperationResult[] = [];

  try {
    await session.withTransaction(
      async () => {
        results = [];

        for (const [index, operation] of body.operations.entries()) {
          const collection = client.db(operation.database).collection(operation.collection);
          const result = await executeOperation(collection, operation, session);

          results.push({
            index,
            operation: operation.operation,
            result,
          });
        }
      },
      body.transactionOptions as TransactionOptions | undefined,
    );

    const response: TransactionResponse = {
      status: "committed",
      results,
    };

    return response;
  } finally {
    await session.endSession();
  }
};

export default [endPoint, h3.defineEventHandler({ handler }), method] as const;
