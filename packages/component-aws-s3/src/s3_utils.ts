import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost, PresignedPost } from '@aws-sdk/s3-presigned-post';

import { ArgOptional, DBOSInitializer, Communicator, CommunicatorContext, InitContext, Transaction, TransactionContext, Workflow, WorkflowContext } from '@dbos-inc/dbos-sdk';
import { v4 as uuidv4 } from 'uuid';
import { Knex } from 'knex';
import { AWSServiceConfig, getAWSConfigForService, getAWSConfigs } from './awscfg';
import { DBOSError } from '@dbos-inc/dbos-sdk/dist/src/error';

export type KnexTransactionContext = TransactionContext<Knex>;

/*
Tracking Table
  Schema
  Interface
  Write transactions
   Start
   Uploaded
   Valid
  Read transactions
   By user / name

Steps for read
  Transaction lookup
  DBOS Read (w/ API Key)
  Client Read (S3 presigned)

Workflow for write (client)
  Pick info
  DB Insert
  Presigned
  Upload complete trigger / cancel timeout
  Validation
  File activation

Workflow for delete (force... we aren't ref counting readers now)
  Pick info
  S3 comm for delete

Example / Test
  Client (node + jest, python, EJS/Next)
    Example client read
    Example client write direct
    Example client write (presigned)

Internal
  Example DBOS read
  DBOS write from within a handler / WF context direct
  DBOS write w/ child workflow (no client)

Other user considerations:
  What if user wants DBOS authentication - logged in user say?
    And if they don't - see below.  But there could also be roles.
  What if user doesn't want to use knex?
  User may want own schema/indexing, and key naming convention...
    In fact there could be a whole policy about file versioning
  What to do to files if a user / anchor record is deleted?
  User may offer world read on the bucket (e.g. product photos), how to get URL.
*/

enum FileStatus
{
    PENDING  = 'Pending',
    RECEIVED = 'Received',
    ACTIVE   = 'Active',
}

export interface UserFile {
    file_id: string,
    user_id: string,
    file_status: string,
    file_type: string,
    file_time: number,
    file_name: string,
}

export interface ResponseError extends Error {
    status?: number;
}
/*
function errorWithStatus(msg: string, st: number) : ResponseError
{
    const err = new Error(msg) as ResponseError;
    err.status = st;
    return err;
}
*/

interface S3Config
{
    configName?: string,
    workflowStage?: string,
}

function createS3Key(rec: UserFile) {
    const key = `${rec.file_type}/${rec.user_id}/${rec.file_id}/${rec.file_time}`;
    return key;
}

export class S3Ops {
    //////////
    // S3 Configuration
    //////////
    static createS3Client(cfg: AWSServiceConfig) {
        return new S3Client({
            region: cfg.region,
            credentials: cfg.credentials,
            maxAttempts: cfg.maxRetries,
        });
    }

    static AWS_S3_CONFIGURATIONS = 'aws_s3_configurations';

    @DBOSInitializer()
    static checkConfig(ctx: InitContext): Promise<void> {
        // Get the config and call the validation
        getAWSConfigs(ctx, S3Ops.AWS_S3_CONFIGURATIONS);
        return Promise.resolve();
    }

    //////////
    //// Database table
    //////////

    // Pick a file ID
    @Communicator()
    static async chooseFileRecord(_ctx: CommunicatorContext, user_id: string, file_type: string, file_name: string): Promise<UserFile> {
        return {
            user_id,
            file_status: FileStatus.PENDING,
            file_type,
            file_id: uuidv4(),
            file_name,
            file_time: new Date().getTime(),
        };
    }

    // File table DML operations
    // Whole record is known
    @Transaction()
    static async insertFileRecord(ctx: KnexTransactionContext, rec: UserFile) {
        await ctx.client<UserFile>('user_files').insert(rec);
    }
    @Transaction()
    static async updateFileRecord(ctx: KnexTransactionContext, rec: UserFile) {
        await ctx.client<UserFile>('user_files').update(rec).where({file_id: rec.file_id});
    }
    @Transaction()
    static async deleteFileRecord(ctx: KnexTransactionContext, rec: UserFile) {
        await ctx.client<UserFile>('user_files').delete().where({file_id: rec.file_id});
    }
    // Delete when part of record is known
    @Transaction()
    static async deleteFileRecordById(ctx: KnexTransactionContext, file_id: string) {
        await ctx.client<UserFile>('user_files').delete().where({file_id});
    }

    // Queries
    @Transaction({readOnly: true})
    static async lookUpByFields(ctx: KnexTransactionContext, user_id: string, fields: UserFile) {
        const rv = await ctx.client<UserFile>('user_files').select().where({...fields, file_status: FileStatus.ACTIVE}).orderBy('file_time', 'desc').first();
        return rv ? [rv] : [];
    }
    @Transaction({readOnly: true})
    static async lookUpByName(ctx: KnexTransactionContext, user_id: string, file_type: string, file_name: string) {
        const rv = await ctx.client<UserFile>('user_files').select().where({user_id, file_type, file_name, file_status: FileStatus.ACTIVE}).orderBy('file_time', 'desc').first();
        return rv ? [rv] : [];
    }
    @Transaction({readOnly: true})
    static async lookUpByType(ctx: KnexTransactionContext, user_id: string, file_type: string) {
        const rv = await ctx.client<UserFile>('user_files').select().where({user_id, file_type, file_status: FileStatus.ACTIVE});
        return rv;
    }
    @Transaction({readOnly: true})
    static async lookUpByUser(ctx: KnexTransactionContext, user_id: string) {
        const rv = await ctx.client<UserFile>('user_files').select().where({user_id, file_status: FileStatus.ACTIVE});
        return rv;
    }

    ///////
    //  Basic functions +
    //  Communicator wrappers for basic functions
    ///////

    // Delete object
    static async deleteS3Cmd(s3: S3Client, bucket: string, key: string)
    {
        return await s3.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
    }

    static async deleteS3(awscfg: AWSServiceConfig, bucket: string, key: string)
    {
        const s3 = S3Ops.createS3Client(awscfg);

        return await S3Ops.deleteS3Cmd(s3, bucket, key);
    }

    @Communicator()
    static async deleteS3Comm(ctx: CommunicatorContext, bucket: string, key: string, @ArgOptional config ?: S3Config)
    {
        const cfg = getAWSConfigForService(ctx, S3Ops.AWS_S3_CONFIGURATIONS, config?.configName ?? "");
        return await S3Ops.deleteS3(cfg, bucket, key);
    }

    // Put small string
    static async putS3Cmd(s3: S3Client, bucket: string, key: string, content: string, contentType: string)
    {
        return await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: contentType,
            Body: content,
        }));
    }

    static async putS3(awscfg: AWSServiceConfig, bucket: string, key: string, content: string, contentType: string)
    {
        const s3 = S3Ops.createS3Client(awscfg);

        return await S3Ops.putS3Cmd(s3, bucket, key, content, contentType);
    }

    @Communicator()
    static async putS3Comm(ctx: CommunicatorContext, bucket: string, key: string, content: string, @ArgOptional contentType: string = 'text/plain', @ArgOptional config ?: S3Config)
    {
        const cfg = getAWSConfigForService(ctx, S3Ops.AWS_S3_CONFIGURATIONS, config?.configName ?? "");
        return await S3Ops.putS3(cfg, bucket, key, content, contentType);
    }

    // Get string
    static async getS3Cmd(s3: S3Client, bucket: string, key: string)
    {
        return await s3.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
    }

    static async getS3(awscfg: AWSServiceConfig, bucket: string, key: string)
    {
        const s3 = S3Ops.createS3Client(awscfg);

        return await S3Ops.getS3Cmd(s3, bucket, key);
    }

    @Communicator()
    static async getS3Comm(ctx: CommunicatorContext, bucket: string, key: string, @ArgOptional config ?: S3Config)
    {
        const cfg = getAWSConfigForService(ctx, S3Ops.AWS_S3_CONFIGURATIONS, config?.configName ?? "");
        return (await S3Ops.getS3(cfg, bucket, key)).Body?.transformToString();
    }

    // Presigned GET key
    static async getS3KeyCmd(s3: S3Client, bucket: string, key: string, expirationSecs: number)
    {
        const getObjectCommand = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        });

        const presignedUrl = await getSignedUrl(s3, getObjectCommand, { expiresIn: expirationSecs, });
        return presignedUrl;
    }

    static async getS3Key(awscfg: AWSServiceConfig, bucket: string, key: string, expirationSecs: number)
    {
        const s3 = S3Ops.createS3Client(awscfg);

        return await S3Ops.getS3KeyCmd(s3, bucket, key, expirationSecs);
    }

    @Communicator()
    static async getS3KeyComm(ctx: CommunicatorContext, bucket: string, key: string, expirationSecs: number = 3600, @ArgOptional config ?: S3Config)
    {
        const cfg = getAWSConfigForService(ctx, S3Ops.AWS_S3_CONFIGURATIONS, config?.configName ?? "");
        return await S3Ops.getS3Key(cfg, bucket, key, expirationSecs);
    }

    // Presigned post key
    static async postS3KeyCmd(s3: S3Client, bucket: string, key: string, expirationSecs: number,
        contentOptions?: {
            contentType?: string,
            contentLengthMin?: number,
            contentLengthMax?: number,
        }
    ) : Promise<PresignedPost>
    {
        const postPresigned = await createPresignedPost(
            s3,
            {
                Conditions: [
                    ["content-length-range", contentOptions?.contentLengthMin ?? 1,
                                            contentOptions?.contentLengthMax ?? 10000000], // 10MB
                ],
                Bucket: bucket,
                Key: key,
                Expires: expirationSecs,
                Fields: {
                    'Content-Type': contentOptions?.contentType ?? '*',
                }
            }
        );
        return {url: postPresigned.url, fields: postPresigned.fields};
    }

    static async postS3Key(awscfg: AWSServiceConfig, bucket: string, key: string, expirationSecs: number,
        contentOptions?: {
            contentType?: string,
            contentLengthMin?: number,
            contentLengthMax?: number,
        })
    {
        const s3 = S3Ops.createS3Client(awscfg);

        return await S3Ops.postS3KeyCmd(s3, bucket, key, expirationSecs, contentOptions);
    }

    @Communicator()
    static async postS3KeyComm(ctx: CommunicatorContext, bucket: string, key: string, expirationSecs: number = 1200,
        @ArgOptional contentOptions?: {
            contentType?: string,
            contentLengthMin?: number,
            contentLengthMax?: number,
        },
        @ArgOptional config ?: S3Config)
    {
        try {
            const cfg = getAWSConfigForService(ctx, S3Ops.AWS_S3_CONFIGURATIONS, config?.configName ?? "");
            return await S3Ops.postS3Key(cfg, bucket, key, expirationSecs, contentOptions);
        }
        catch (e) {
            ctx.logger.error(e);
            throw new DBOSError(`Unable to presign post: ${(e as Error).message}`, 500);
        }
    }

    /////////
    // Simple Workflows
    /////////

    // Send a data string item directly to S3
    // Use cases for this:
    //  App code produces (or received from the user) _small_ data to store in S3 
    //   One-shot workflow
    //     Pick a file name
    //     Do the S3 op
    //     If it succeeds, write in table
    //     If it fails drop the partial file (if any) from S3
    // Note this will ALL get logged in the DB as a workflow parameter (and a communicator parameter) so better not be big!
    @Workflow()
    static async saveStringToFile(ctx: WorkflowContext, user_id: string, file_type: string, file_name: string, bucket:string, content: string, @ArgOptional contentType = 'text/plain', @ArgOptional
        config?: S3Config) 
    {
        const rec = await ctx.invoke(S3Ops).chooseFileRecord(user_id, file_type, file_name);
        const key = createS3Key(rec);

        // Running this as a communicator could possibly be skipped... but only for efficiency
        try {
            await ctx.invoke(S3Ops).putS3Comm(bucket, key, content, contentType, config);
        }
        catch (e) {
            await ctx.invoke(S3Ops).deleteS3Comm(bucket, key, config);
            throw e;
        }
    
        rec.file_status = 'Active';
        await ctx.invoke(S3Ops).insertFileRecord(rec);
        return rec;
    }

    //  App code reads a file out of S3
    //  Just a routine, hardly worthy of a workflow
    //    Does the DB query
    //    Does the S3 read
    @Workflow()
    static async readStringFromFile(ctx: WorkflowContext, user_id: string, file_type: string, file_name: string, bucket: string, @ArgOptional
        config?: S3Config)
    {
        const rec = await ctx.invoke(S3Ops).lookUpByName(user_id, file_type, file_name);
        if (rec.length !== 1) throw new DBOSError(`Didn't find exactly 1 file: ${rec.length}`);
        const key = createS3Key(rec[0]);
        const txt = await ctx.invoke(S3Ops).getS3Comm(bucket, key, config);
        return txt;
    }

    //  App code deletes a file out of S3
    //   One-shot workflow
    //     Do the table write
    //     Do the S3 op
    //   Wrapper function to wait
    @Workflow()
    static async deleteFile(ctx: WorkflowContext, user_id: string, file_type: string, file_name: string, bucket: string, @ArgOptional
        config?: S3Config)
    {
        const rec = await ctx.invoke(S3Ops).lookUpByName(user_id, file_type, file_name);
        if (rec.length !== 1) throw new DBOSError(`Didn't find exactly 1 file: ${rec.length}`);
        const key = createS3Key(rec[0]);
        await ctx.invoke(S3Ops).deleteFileRecord(rec[0]);
        return await ctx.invoke(S3Ops).deleteS3Comm(bucket, key, config);
    }

    ////////////
    // Workflows where client goes direct to S3 (slightly more complicated)
    ////////////

    // There are cases where we don't want to store the data in the DB
    //   Especially end-user uploads, or cases where the file is accessed by outside systems

    //  Presigned D/L for end user
    //    Hardly warrants a full workflow
    @Workflow()
    static async getFileReadURL(ctx: WorkflowContext, user_id: string, file_type: string, file_name: string, bucket: string, @ArgOptional expirationSec = 3600, @ArgOptional
        config?: S3Config) : Promise<string>
    {
        const rec = await ctx.invoke(S3Ops).lookUpByName(user_id, file_type, file_name);
        if (rec.length !== 1) throw new DBOSError(`Didn't find exactly 1 file: ${rec.length} for ${user_id}/${file_type}/${file_name}`);
        const key = createS3Key(rec[0]);
        return await ctx.invoke(S3Ops).getS3KeyComm(bucket, key, expirationSec, config);
    }

    //  Presigned U/L for end user
    //    A workflow that creates a presigned post
    //    Sets that back for the caller
    //    Waits for a completion
    //    If it gets it, adds the DB entry
    //      Should it poll for upload in case nobody tells it?  (Do a HEAD request w/ exponential backoff, listen to SQS)
    //      The poll will end significantly after the S3 post URL expires, so we'll know
    //    This will support an OAOO key on the workflow, no problem.
    //      We won't start that completion checker more than once
    //      If you ask again, you get the same presigned post URL
    @Workflow()
    static async writeFileViaURL(ctx: WorkflowContext, user_id: string, file_type: string, file_name: string, bucket: string,
        @ArgOptional expirationSec = 3600,
        @ArgOptional contentOptions?: {
            contentType?: string,
            contentLengthMin?: number,
            contentLengthMax?: number,
        },
        @ArgOptional config?: S3Config) : Promise<UserFile>
    {
        const rec = await ctx.invoke(S3Ops).chooseFileRecord(user_id, file_type, file_name);
        rec.file_status = FileStatus.PENDING;
        await ctx.invoke(S3Ops).insertFileRecord(rec); // TODO: Any conflict checking?

        const key = createS3Key(rec);

        const upkey = await ctx.invoke(S3Ops).postS3KeyComm(bucket, key, expirationSec, contentOptions, config);
        await ctx.setEvent<PresignedPost>("uploadkey", upkey);

        try {
            await ctx.recv("uploadfinish", expirationSec + 60); // 1 minute extra?
            rec.file_status = FileStatus.RECEIVED;

            // TODO: Validate the file

            await ctx.invoke(S3Ops).updateFileRecord(rec);
        }
        catch (e) {
            try {
                // This should probably be by ID...
                const _cwfh = await ctx.childWorkflow(S3Ops.deleteFile, user_id, file_type, file_name, bucket, config);
                // No reason to await result
            }
            catch (e2) {
            }
            throw e;
        }
        rec.file_status = FileStatus.ACTIVE;
        await ctx.invoke(S3Ops).updateFileRecord(rec);

        return rec;
    }
}

/*
// Send multi-part to S3 (passthrough)
//   You could do this with a handler context but WHY?
//   You wouldn't get any guarantees, the only thing would be that the URL
//     looks like DBOS and we could check things in DBOS...

router.post('/upload', koaBody({ multipart: true }), async (ctx) => {
  const file = ctx.request.files?.file;

  if (!file) {
    ctx.status = 400;
    ctx.body = 'File not uploaded.';
    return;
  }

  const fileStream = new stream.PassThrough();
  fileStream.end((file as any).buffer);

  const params = {
    Bucket: 'your-s3-bucket-name',
    Key: `uploads/${Date.now()}-${file.name}`,
    Body: fileStream,
    ContentType: file.type,
  };

  try {
    const data = await s3.upload(params).promise();
    ctx.body = 'File uploaded successfully';
  } catch (err) {
    ctx.status = 500;
    ctx.body = 'Failed to upload to S3.';
  }
});
*/