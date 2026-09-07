import * as h3 from "h3";

import transaction from "../handlers/custom/transaction";
import transferPoints from "../handlers/custom/transfer-points";

export const router = h3
  .createRouter()
  .add(...transaction)
  .add(...transferPoints);
