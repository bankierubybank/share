import type { Category } from "./api";
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

/** Translated label for the current UI language. */
export const categoryLabel = (c: Category) => t(CATEGORY_META[c].key);
