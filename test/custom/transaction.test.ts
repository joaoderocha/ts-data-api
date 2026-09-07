import { ObjectId } from "mongodb";

import { endPoint } from "../../src/handlers/custom/transaction";
import { dataSources } from "../../src/mdb";
import { requester, withDb } from "../helpers";

const target = (collection: string, database = "test") => ({
  database,
  collection,
});

withDb(() => {
  const client = dataSources.local;
  const otherDatabase = "transaction_other_test";

  beforeEach(async () => {
    await client.db(otherDatabase).dropDatabase();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("Transaction", () => {
    test("executes operations in order and commits native results", async () => {
      const _id = new ObjectId();
      const { body, status } = await requester({
        url: endPoint,
        data: {
          dataSource: "local",
          transactionOptions: { readPreference: "primary" },
          operations: [
            {
              operation: "insertOne",
              ...target("ordered"),
              document: { _id, value: 1 },
              options: { comment: "transaction-operation" },
            },
            {
              operation: "updateOne",
              ...target("ordered"),
              filter: { _id },
              update: { $inc: { value: 1 } },
            },
            {
              operation: "deleteOne",
              ...target("ordered"),
              filter: { _id },
            },
          ],
        },
      });

      expect(status).toBe(200);
      expect(body.status).toBe("committed");
      expect(body.results.map((result: { operation: string }) => result.operation)).toEqual([
        "insertOne",
        "updateOne",
        "deleteOne",
      ]);
      expect(body.results[0]).toMatchObject({
        index: 0,
        result: { acknowledged: true, insertedId: _id },
      });
      expect(body.results[1].result).toMatchObject({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
      });
      expect(body.results[2].result).toMatchObject({
        acknowledged: true,
        deletedCount: 1,
      });

      await expect(client.db("test").collection("ordered").findOne({ _id })).resolves.toBeNull();
    });

    test("supports insertMany, updateMany, replaceOne, and deleteMany", async () => {
      const replaceId = new ObjectId();
      const collection = client.db("test").collection("remaining_operations");
      await collection.insertMany([
        { _id: replaceId, group: "replace", value: 0 },
        { group: "update", value: 0 },
        { group: "update", value: 0 },
        { group: "delete" },
        { group: "delete" },
      ]);

      const { body, status } = await requester({
        url: endPoint,
        data: {
          dataSource: "local",
          transactionOptions: { readPreference: "primary" },
          operations: [
            {
              operation: "insertMany",
              ...target("remaining_operations"),
              documents: [{ group: "inserted" }, { group: "inserted" }],
            },
            {
              operation: "updateMany",
              ...target("remaining_operations"),
              filter: { group: "update" },
              update: [{ $set: { value: 1 } }],
            },
            {
              operation: "replaceOne",
              ...target("remaining_operations"),
              filter: { _id: replaceId },
              replacement: { group: "replaced" },
            },
            {
              operation: "deleteMany",
              ...target("remaining_operations"),
              filter: { group: "delete" },
            },
          ],
        },
      });

      expect(status).toBe(200);
      expect(body.results[0].result).toMatchObject({
        acknowledged: true,
        insertedCount: 2,
      });
      expect(body.results[1].result).toMatchObject({
        acknowledged: true,
        matchedCount: 2,
        modifiedCount: 2,
      });
      expect(body.results[2].result).toMatchObject({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
      });
      expect(body.results[3].result).toMatchObject({
        acknowledged: true,
        deletedCount: 2,
      });
      await expect(collection.countDocuments({ group: "inserted" })).resolves.toBe(2);
      await expect(collection.countDocuments({ group: "update", value: 1 })).resolves.toBe(2);
      await expect(collection.countDocuments({ group: "replaced" })).resolves.toBe(1);
      await expect(collection.countDocuments({ group: "delete" })).resolves.toBe(0);
    });

    test("supports multiple collections and databases on one data source", async () => {
      const firstId = new ObjectId();
      const secondId = new ObjectId();
      const { body, status } = await requester({
        url: endPoint,
        data: {
          dataSource: "local",
          operations: [
            {
              operation: "insertOne",
              ...target("first_collection"),
              document: { _id: firstId },
            },
            {
              operation: "insertOne",
              ...target("second_collection", otherDatabase),
              document: { _id: secondId },
            },
          ],
          transactionOptions: { readPreference: "primary" },
        },
      });

      expect(status).toBe(200);
      expect(body.status).toBe("committed");
      await expect(
        client.db("test").collection("first_collection").countDocuments({ _id: firstId }),
      ).resolves.toBe(1);
      await expect(
        client.db(otherDatabase).collection("second_collection").countDocuments({ _id: secondId }),
      ).resolves.toBe(1);
    });

    test("returns documents from findOneAnd operations", async () => {
      const updateId = new ObjectId();
      const replaceId = new ObjectId();
      const deleteId = new ObjectId();
      const collection = client.db("test").collection("find_and_modify");
      await collection.insertMany([
        { _id: updateId, value: "before" },
        { _id: replaceId, value: "replace" },
        { _id: deleteId, value: "delete" },
      ]);

      const { body, status } = await requester({
        url: endPoint,
        data: {
          dataSource: "local",
          transactionOptions: { readPreference: "primary" },
          operations: [
            {
              operation: "findOneAndUpdate",
              ...target("find_and_modify"),
              filter: { _id: updateId },
              update: { $set: { value: "after" } },
              options: { returnDocument: "after" },
            },
            {
              operation: "findOneAndReplace",
              ...target("find_and_modify"),
              filter: { _id: replaceId },
              replacement: { value: "replaced" },
              options: { returnDocument: "after" },
            },
            {
              operation: "findOneAndDelete",
              ...target("find_and_modify"),
              filter: { _id: deleteId },
            },
          ],
        },
      });

      expect(status).toBe(200);
      expect(body.results[0].result).toMatchObject({
        _id: updateId,
        value: "after",
      });
      expect(body.results[1].result).toMatchObject({
        _id: replaceId,
        value: "replaced",
      });
      expect(body.results[2].result).toMatchObject({
        _id: deleteId,
        value: "delete",
      });
    });

    test("supports aggregate, countDocuments, distinct, find, and findOne", async () => {
      const firstId = new ObjectId();
      const secondId = new ObjectId();
      const collection = client.db("test").collection("read_operations");
      await collection.insertMany([
        { _id: firstId, group: "a", value: 1 },
        { _id: secondId, group: "a", value: 2 },
        { group: "b", value: 3 },
      ]);

      const { body, status } = await requester({
        url: endPoint,
        data: {
          dataSource: "local",
          transactionOptions: { readPreference: "primary" },
          operations: [
            {
              operation: "findOne",
              ...target("read_operations"),
              filter: { _id: firstId },
            },
            {
              operation: "find",
              ...target("read_operations"),
              filter: { group: "a" },
              options: { sort: { value: 1 } },
            },
            {
              operation: "countDocuments",
              ...target("read_operations"),
              filter: { group: "a" },
            },
            {
              operation: "distinct",
              ...target("read_operations"),
              key: "group",
            },
            {
              operation: "aggregate",
              ...target("read_operations"),
              pipeline: [
                { $group: { _id: "$group", total: { $sum: "$value" } } },
                { $sort: { _id: 1 } },
              ],
            },
          ],
        },
      });

      expect(status).toBe(200);
      expect(body.results.map(({ operation }: { operation: string }) => operation)).toEqual([
        "findOne",
        "find",
        "countDocuments",
        "distinct",
        "aggregate",
      ]);
      expect(body.results[0].result).toMatchObject({
        _id: firstId,
        group: "a",
        value: 1,
      });
      expect(body.results[1].result).toEqual([
        { _id: firstId, group: "a", value: 1 },
        { _id: secondId, group: "a", value: 2 },
      ]);
      expect(body.results[2].result).toBe(2);
      expect(body.results[3].result.sort()).toEqual(["a", "b"]);
      expect(body.results[4].result).toEqual([
        { _id: "a", total: 3 },
        { _id: "b", total: 3 },
      ]);
    });

    test("rolls back prior writes across databases after a duplicate key error", async () => {
      const collection = client.db(otherDatabase).collection("rollback_destination");
      await collection.createIndex({ uniqueValue: 1 }, { unique: true });
      await collection.insertOne({ uniqueValue: "duplicate" });
      const priorId = new ObjectId();
      const laterId = new ObjectId();

      const { body, status } = await requester({
        url: endPoint,
        data: {
          dataSource: "local",
          transactionOptions: { readPreference: "primary" },
          operations: [
            {
              operation: "insertOne",
              ...target("rollback_origin"),
              document: { _id: priorId },
            },
            {
              operation: "insertOne",
              ...target("rollback_destination", otherDatabase),
              document: { uniqueValue: "duplicate" },
            },
            {
              operation: "insertOne",
              ...target("rollback_origin"),
              document: { _id: laterId },
            },
          ],
        },
      });

      expect(status).toBe(500);
      expect(body.message).toContain("E11000 duplicate key error");
      await expect(
        client.db("test").collection("rollback_origin").countDocuments({}),
      ).resolves.toBe(0);
      await expect(collection.countDocuments({ uniqueValue: "duplicate" })).resolves.toBe(1);
    });

    test.each([
      ["empty operations", { dataSource: "local", operations: [] }],
      [
        "unknown plan field",
        {
          dataSource: "local",
          operations: [
            {
              operation: "deleteOne",
              ...target("validation"),
              filter: {},
            },
          ],
          unexpected: true,
        },
      ],
      [
        "unknown operation field",
        {
          dataSource: "local",
          operations: [
            {
              operation: "deleteOne",
              ...target("validation"),
              filter: {},
              unexpected: true,
            },
          ],
        },
      ],
      [
        "missing operation target",
        {
          dataSource: "local",
          operations: [{ operation: "deleteOne", filter: {} }],
        },
      ],
      [
        "empty operation target",
        {
          dataSource: "local",
          operations: [
            {
              operation: "deleteOne",
              database: "",
              collection: "",
              filter: {},
            },
          ],
        },
      ],
      [
        "invalid data source",
        {
          dataSource: "missing",
          operations: [
            {
              operation: "deleteOne",
              ...target("validation"),
              filter: {},
            },
          ],
        },
      ],
    ] as Array<[string, object]>)("rejects %s during preflight validation", async (_name, data) => {
      const startSession = jest.spyOn(client, "startSession");
      const { body, status } = await requester({ url: endPoint, data });

      expect(status).toBe(400);
      expect(body.message).toContain("Body expected not provided");
      expect(startSession).not.toHaveBeenCalled();
    });

    test.each(["application/json", "application/ejson"] as const)(
      "supports %s request and response serialization",
      async (contentType) => {
        const _id = new ObjectId();
        const { body, status } = await requester({
          url: endPoint,
          contentType,
          data: {
            dataSource: "local",
            transactionOptions: { readPreference: "primary" },
            operations: [
              {
                operation: "insertOne",
                ...target(`serialization_${contentType.replace("/", "_")}`),
                document: { _id },
              },
            ],
          },
        });

        expect(status).toBe(200);
        if (contentType === "application/ejson") {
          expect(body.results[0].result.insertedId).toEqual(_id);
        } else {
          expect(body.results[0].result.insertedId).toBe(_id.toHexString());
        }
      },
    );

    test("clears results from a managed callback retry", async () => {
      const transientError = new Error("retry attempt");
      const insertOne = jest
        .fn()
        .mockResolvedValueOnce({
          acknowledged: true,
          insertedId: "first-attempt-result",
        })
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({
          acknowledged: true,
          insertedId: "final-attempt-first-result",
        })
        .mockResolvedValueOnce({
          acknowledged: true,
          insertedId: "final-attempt-second-result",
        });
      const endSession = jest.fn().mockResolvedValue(undefined);
      const session = {
        withTransaction: jest.fn(async (callback: () => Promise<void>) => {
          await expect(callback()).rejects.toBe(transientError);
          await callback();
        }),
        endSession,
      };
      jest.spyOn(client, "startSession").mockReturnValue(session as never);
      jest.spyOn(client, "db").mockReturnValue({
        collection: () => ({ insertOne }),
      } as never);

      const { body, status } = await requester({
        url: endPoint,
        data: {
          dataSource: "local",
          operations: [
            {
              operation: "insertOne",
              ...target("mocked_retry"),
              document: { position: 1 },
            },
            {
              operation: "insertOne",
              ...target("mocked_retry"),
              document: { position: 2 },
            },
          ],
        },
      });

      expect(status).toBe(200);
      expect(insertOne).toHaveBeenCalledTimes(4);
      expect(body.results).toHaveLength(2);
      expect(body.results[0].result.insertedId).toBe("final-attempt-first-result");
      expect(body.results[1].result.insertedId).toBe("final-attempt-second-result");
      expect(endSession).toHaveBeenCalledTimes(1);
    });
  });
});
