import { z } from 'zod';

const savedCartIdSchema = z.string().regex(/^[1-9][0-9]*$/);
const chainIdSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const digestSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const quantitySchema = z.string().regex(/^[1-9][0-9]*$/);

export const savedCartItemSchema = z.object({
  listingDigest: digestSchema,
  quantity: quantitySchema,
});

export const savedCartSchema = z.object({
  id: savedCartIdSchema,
  chainId: chainIdSchema,
  cartAddress: addressSchema,
  purchaseCurrency: addressSchema.nullable(),
  items: z.array(savedCartItemSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export const savedCartResponseSchema = z.object({ data: savedCartSchema });

export const savedCartListResponseSchema = z.object({
  data: z.array(savedCartSchema),
  hasNextPage: z.boolean(),
});

export type SavedCart = z.infer<typeof savedCartSchema>;
export type SavedCartItem = z.infer<typeof savedCartItemSchema>;

export type SavedCartListParams = {
  page?: number;
  perPage?: number;
};

export type SavedCartCreateParams = {
  chainId: string;
  cartAddress: string;
  purchaseCurrency?: string | null;
};

export type SavedCartUpdateParams = {
  cartId: string;
  purchaseCurrency: string | null;
};

export type SavedCartItemParams = {
  cartId: string;
  listingDigest: string;
};

export type SavedCartItemPutParams = SavedCartItemParams & {
  quantity: string;
};
