import { z } from 'zod';

/**
 * Product metadata is deliberately kept as a typed presentation object. The
 * Rare API owns validation and persistence; this schema protects the SDK
 * boundary from returning an untyped JSON blob to an integrator.
 */
export const productMediaSchema = z.object({
  url: z.string().min(1),
  mediaType: z.enum(['image', 'video']),
  posterUrl: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
}).catchall(z.unknown());

export const productMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  supplementalMedia: z.array(productMediaSchema).optional(),
  tags: z.array(z.string()).optional(),
}).catchall(z.unknown());

export const productVariantSchema = z.object({
  id: z.string().regex(/^[1-9][0-9]*$/),
  productId: z.string().regex(/^[1-9][0-9]*$/),
  sku: z.string().min(1),
  universalTokenId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative(),
  isHidden: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
}).strict();

export const productSchema = z.object({
  id: z.string().regex(/^[1-9][0-9]*$/),
  userId: z.string().regex(/^[1-9][0-9]*$/),
  slug: z.string().nullable(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
  metadata: productMetadataSchema,
  variants: z.array(productVariantSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

export const productPersistenceRecordSchema = z.object({
  resourceType: z.string().min(1),
  id: z.string().regex(/^[1-9][0-9]*$/),
  record: z.record(z.string(), z.unknown()),
}).strict();

const productPageSchema = <T extends z.ZodType>(itemSchema: T) => z.object({
  data: z.array(itemSchema),
  hasNextPage: z.boolean(),
}).strict();

export const productListResponseSchema = productPageSchema(productSchema);
export const productCandidateListResponseSchema = z.object({
  records: z.array(productPersistenceRecordSchema),
  hasNextPage: z.boolean(),
}).strict();

export const productResponseSchema = z.object({ data: productSchema }).strict();

export type ProductMedia = z.infer<typeof productMediaSchema>;
export type ProductMetadata = z.infer<typeof productMetadataSchema>;
export type ProductVariant = z.infer<typeof productVariantSchema>;
export type Product = z.infer<typeof productSchema>;
export type ProductPersistenceRecord = z.infer<typeof productPersistenceRecordSchema>;
export type ProductCandidate = ProductPersistenceRecord;
export type ProductRecordPage = z.infer<typeof productCandidateListResponseSchema>;
export type ProductPage<T> = {
  data: T[];
  hasNextPage: boolean;
};

export type ProductWriteParams = {
  slug?: string | null;
  metadata: ProductMetadata;
};

export type ProductUpdateParams = ProductWriteParams;

export type ProductListParams = {
  page?: number;
  perPage?: number;
};

export type ProductCandidateListParams = ProductListParams & {
  productId?: string;
};

export type AddProductVariantsParams = {
  productId: string;
  universalTokenIds: string[];
};

export type RemoveProductVariantParams = {
  productId: string;
  variantId: string;
};

export type ReorderProductVariantsParams = {
  productId: string;
  variantIds: string[];
};

export type SetProductVariantVisibilityParams = {
  productId: string;
  variantId: string;
  isHidden: boolean;
};
