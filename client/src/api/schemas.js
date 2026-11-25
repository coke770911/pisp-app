// @ts-check
/**
 * API 回應的 schema 驗證（依 docs/CONTRACT.md）。
 * 外部輸入一律先經 zod 驗證，再以明確型別使用。
 */
import { z } from 'zod';

/** 寬鬆整數：後端可能回傳數字字串，統一轉為整數 */
const int = z.coerce.number().int();

export const ErrorBodySchema = z.object({ message: z.string() });

export const UserSchema = z.object({ username: z.string() });
/** @typedef {z.infer<typeof UserSchema>} User */

export const BracketSchema = z.object({
  id: int.optional(),
  roc_year: int.optional(),
  salary_limit: int,
  labor_emp: int,
  labor_school: int,
  labor_occupational: int,
  pension_school: int,
  health_emp: int,
  health_school: int,
});
/** @typedef {z.infer<typeof BracketSchema>} BracketRow */

export const BracketListSchema = z.array(BracketSchema);
export const YearListSchema = z.array(int);

export const BracketImportResultSchema = z.object({ year: int, count: int });
/** @typedef {z.infer<typeof BracketImportResultSchema>} BracketImportResult */

export const BracketYearDeleteResultSchema = z.object({ year: int, deleted: int });
/** @typedef {z.infer<typeof BracketYearDeleteResultSchema>} BracketYearDeleteResult */

export const OkResultSchema = z.object({ ok: z.boolean() }).passthrough();

export const InsuranceTypeSchema = z.enum(['勞健', '公健']);
/** @typedef {z.infer<typeof InsuranceTypeSchema>} InsuranceType */

export const PayrollStatusSchema = z.enum(['draft', 'confirmed']);
export const MonthStatusSchema = z.enum(['none', 'draft', 'confirmed']);
/** @typedef {z.infer<typeof MonthStatusSchema>} MonthStatus */

export const PayrollItemSchema = z.object({
  id: int.optional(),
  source_name: z.string(),
  amount: int,
  sort_order: int.optional(),
});
/** @typedef {z.infer<typeof PayrollItemSchema>} PayrollItem */

export const PayrollSchema = z.object({
  id: int,
  roc_year: int,
  month: int,
  employee_no: z.string(),
  name: z.string(),
  id_number: z.string().nullable().optional(),
  birthday: z.string().nullable().optional(),
  insurance_type: InsuranceTypeSchema,
  base_salary: int,
  /** 勞退自提率（%，0~6）；舊資料缺值時視為 0（超出範圍不擋，計算時由 normalizePensionRate 視為 0） */
  pension_rate: int.default(0),
  status: PayrollStatusSchema,
  items: z.array(PayrollItemSchema),
});
/** @typedef {z.infer<typeof PayrollSchema>} Payroll */

export const MonthDataSchema = z.object({
  year: int,
  month: int,
  status: MonthStatusSchema,
  payrolls: z.array(PayrollSchema),
});
/** @typedef {z.infer<typeof MonthDataSchema>} MonthData */

export const PayrollImportResultSchema = z.object({
  year: int,
  month: int,
  count: int,
  laborCount: int,
  publicCount: int,
  warnings: z.array(z.string()),
});
/** @typedef {z.infer<typeof PayrollImportResultSchema>} PayrollImportResult */

export const StatusResultSchema = z.object({ status: PayrollStatusSchema });
/** @typedef {z.infer<typeof StatusResultSchema>} StatusResult */

export const CopyResultSchema = z.object({ year: int, month: int, count: int });
/** @typedef {z.infer<typeof CopyResultSchema>} CopyResult */
