import { z } from "zod";
import { defineHttpEndpointContract } from "../../kernel/http-contract";
import { errorSourceTypeSchema } from "./error-sources.schemas";

export const DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT = 20;

export const externalSourceQuerySourceTypeSchema = errorSourceTypeSchema;

export const externalSourceQueryRequestSchema = z.object({
  executionId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  sourceId: z.string().trim().min(1),
  sourceType: externalSourceQuerySourceTypeSchema,
  sourceName: z.string().trim().min(1),
  organizationSlug: z.string().trim().optional(),
  projectSlugs: z.array(z.string().trim().min(1)).default([]),
  accessToken: z.string().trim().optional(),
  baseUrl: z.url().optional(),
  indexPatterns: z.array(z.string().trim().min(1)).default([]),
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(100).default(DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT),
});

export const externalSourceQueryResponseSchema = z.object({
  output: z.string(),
  issueCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  items: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type ExternalSourceQueryRequest = z.infer<
  typeof externalSourceQueryRequestSchema
>;
export type ExternalSourceQueryResponse = z.infer<
  typeof externalSourceQueryResponseSchema
>;

export const externalSourceWorkerContracts = {
  query: defineHttpEndpointContract({
    method: "POST",
    path: "/external-sources/query",
    requestEncoding: "body",
    requestSchema: externalSourceQueryRequestSchema,
    responseSchema: externalSourceQueryResponseSchema,
  }),
};
