import { z } from "zod";

export const globalVariableKeySchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_.-]*$/,
    "Global variable keys must start with a letter or underscore and contain only letters, numbers, underscores, dots, and hyphens",
  );

export const desktopGlobalVariableScopeSchema = z.object({
  product: z.literal("bitsentry-desktop"),
  owner: z.literal("local_app"),
});

export const dashboardGlobalVariableScopeSchema = z.object({
  product: z.literal("dashboard"),
  owner: z.literal("user"),
  userId: z.string().trim().min(1),
});

export const globalVariableScopeSchema = z.union([
  desktopGlobalVariableScopeSchema,
  dashboardGlobalVariableScopeSchema,
]);

export const globalVariableSchema = z.object({
  id: z.string(),
  key: globalVariableKeySchema,
  value: z.string().optional(),
  valueRef: z.string().optional(),
  description: z.string().optional(),
  secure: z.boolean().optional(),
  scope: globalVariableScopeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const globalVariableInputSchema = z.object({
  key: globalVariableKeySchema,
  value: z.string().optional(),
  valueRef: z.string().optional(),
  description: z.string().optional(),
  secure: z.boolean().optional(),
});

export const globalVariablePatchSchema = z.object({
  key: globalVariableKeySchema.optional(),
  value: z.string().optional(),
  valueRef: z.string().optional(),
  description: z.string().optional(),
  secure: z.boolean().optional(),
});

export type GlobalVariableScope = z.infer<typeof globalVariableScopeSchema>;
export type GlobalVariable = z.infer<typeof globalVariableSchema>;
export type GlobalVariableInput = z.infer<typeof globalVariableInputSchema>;
export type GlobalVariablePatch = z.infer<typeof globalVariablePatchSchema>;
