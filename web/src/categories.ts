import type { BillCategory, Category, CustomCategory } from "./api";
import type { IconName } from "./icons";
import { t, type TKey } from "./i18n";

export const CATEGORY_META: Record<Category, { key: TKey; icon: IconName }> = {
  food: { key: "category.food", icon: "restaurant" },
  groceries: { key: "category.groceries", icon: "shopping_cart" },
  lodging: { key: "category.lodging", icon: "hotel" },
  transport: { key: "category.transport", icon: "directions_car" },
  activities: { key: "category.activities", icon: "local_activity" },
  shopping: { key: "category.shopping", icon: "shopping_bag" },
  utilities: { key: "category.utilities", icon: "bolt" },
  other: { key: "category.misc", icon: "receipt" },
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_META) as Category[];

/** Icons a trip's own category can use (v0.11). Keep in sync with CUSTOM_ICONS in src/lib/validate.ts. */
export const CUSTOM_ICONS = [
  "label", "flight", "train", "local_gas_station", "local_cafe", "local_bar", "restaurant", "shopping_cart", "hotel",
  "directions_car", "local_activity", "shopping_bag", "celebration", "spa", "hiking", "beach_access", "fitness_center",
  "sports_soccer", "pets", "medical_services", "school", "sell", "bolt", "receipt",
] as const satisfies readonly IconName[];

const isBuiltIn = (c: string): c is Category => c in CATEGORY_META;

/**
 * Label + icon of a bill's category: built-in (translated) or one of the trip's own. A deleted own category reads as
 * "Other" (its bills keep the id).
 */
export function categoryInfo(c: BillCategory, custom: readonly CustomCategory[] = []): { label: string; icon: IconName } {
  if (isBuiltIn(c)) return { label: t(CATEGORY_META[c].key), icon: CATEGORY_META[c].icon };
  const own = custom.find((x) => `c:${x.id}` === c);
  return own
    ? { label: own.name, icon: (CUSTOM_ICONS as readonly string[]).includes(own.icon) ? (own.icon as IconName) : "label" }
    : { label: t(CATEGORY_META.other.key), icon: CATEGORY_META.other.icon };
}

/** Translated label for the current UI language. */
export const categoryLabel = (c: BillCategory, custom: readonly CustomCategory[] = []) => categoryInfo(c, custom).label;
