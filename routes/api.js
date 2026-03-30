const express = require("express");
const router = express.Router();
const { sql, getConnection } = require("../db");
const e = require("express");

//========================================== LOGIN ==========================================

router.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        const pool = await getConnection();

        const result = await pool.request()
            .input("username", sql.VarChar, username)
            .input("password", sql.VarChar, password)
            .query(`
                SELECT id, username, role, branch 
                FROM pettyusers
                WHERE username = @username AND passcode = @password
            `);

        if (result.recordset.length > 0) {
            return res.json({
                status: "success",
                data: result.recordset[0]
            });
        } else {
            return res.status(401).json({
                status: "fail",
                message: "Invalid username or password"
            });
        }

    } catch (error) {
        console.log("LOGIN ERROR:", error);
        return res.status(500).json({
            status: "error",
            message: "Server issue"
        });
    }
});

const getLastBalance = async (pool, branch) => {
  const result = await pool.request()
    .input("Branch", sql.VarChar, branch)
    .query(`
      SELECT TOP 1 ClosingBalance 
      FROM CashInventory
      WHERE Branch=@Branch
      ORDER BY Id DESC
    `);

  if (result.recordset.length > 0) {
    return result.recordset[0].ClosingBalance;
  }

  // 🔥 fallback to opening balance
  const opening = await pool.request()
    .input("Branch", sql.VarChar, branch)
    .query(`
      SELECT OpeningBalance 
      FROM BranchOpeningBalance 
      WHERE Branch=@Branch
    `);

  return opening.recordset[0].OpeningBalance;
};

const insertInventory = async (
  pool,
  branch,
  voucher,
  refVoucher,
  type,
  amount,
  isDebit,
  description,
  user
) => {

  const opening = await getLastBalance(pool, branch);

  let debit = 0;
  let credit = 0;

  if (isDebit) debit = amount;
  else credit = amount;

 const openingNum = Number(opening);
const debitNum = Number(debit);
const creditNum = Number(credit);

const closing = openingNum - debitNum + creditNum;

  console.log('closing - ',closing);  
  await pool.request()
    .input("Branch", sql.VarChar, branch)
    .input("VoucherNo", sql.VarChar, voucher)
    .input("RefVoucherNo", sql.VarChar, refVoucher)
    .input("TranType", sql.VarChar, type)
    .input("Description", sql.VarChar, description)
    .input("Debit", sql.Decimal(18,2), debit)
    .input("Credit", sql.Decimal(18,2), credit)
    .input("OpeningBalance", sql.Decimal(18,2), opening)
    .input("ClosingBalance", sql.Decimal(18,2), closing)
    .input("CreatedBy", sql.VarChar, user)
    .query(`
      INSERT INTO CashInventory
      (Branch, VoucherNo, RefVoucherNo, TranType, Description, Debit, Credit, OpeningBalance, ClosingBalance, CreatedBy)
      VALUES
      (@Branch, @VoucherNo, @RefVoucherNo, @TranType, @Description, @Debit, @Credit, @OpeningBalance, @ClosingBalance, @CreatedBy)
    `);
};



//========================================== GET EXPENSES ==========================================

router.get("/expenses", async (req, res) => {
    try {
        console.log("Fetching expenses...");

        const pool = await getConnection();

        const result = await pool.request()
            .query("SELECT * FROM CashboxExpenses ORDER BY Id DESC");

        return res.json(result.recordset);

    } catch (err) {
        console.log("EXPENSE FETCH ERROR:", err);
        return res.status(500).json({ error: err.message });
    }
});


//========================================== INSERT EXPENSE ==========================================

router.post("/expenses", async (req, res) => {
    try {
        const pool = await getConnection();

        const {
            VoucherNo,
            Type,
            ExpenseCategory,
            EmployeeCode,
            Date,
            ApprovedBy,
            LedgerName,
            Amount,
            Purpose
        } = req.body;

        console.log("Incoming Data:", req.body);

        // ✅ VALIDATION (MANDATORY)
        if (
            !VoucherNo || !Type || !ExpenseCategory || !EmployeeCode ||
            !Date || !ApprovedBy || !LedgerName || !Amount || !Purpose
        ) {
            return res.status(400).json({
                message: "All fields are required"
            });
        }

        // ✅ INSERT INTO MAIN TABLE (WITH OUTPUT)
        const result = await pool.request()
            .input("VoucherNo", sql.VarChar, VoucherNo)
            .input("Type", sql.VarChar, Type)
            .input("ExpenseCategory", sql.VarChar, ExpenseCategory)
            .input("EmployeeCode", sql.VarChar, EmployeeCode)
            .input("Date", sql.Date, Date)
            .input("ApprovedBy", sql.VarChar, ApprovedBy)
            .input("LedgerName", sql.VarChar, LedgerName)
            .input("Amount", sql.Decimal(18, 2), Amount)
            .input("Purpose", sql.VarChar, Purpose)
            .query(`
                INSERT INTO CashboxExpenses
                (VoucherNo, Type, ExpenseCategory, EmployeeCode, Date, ApprovedBy, LedgerName, Amount, Purpose)
                OUTPUT INSERTED.Id
                VALUES
                (@VoucherNo, @Type, @ExpenseCategory, @EmployeeCode, @Date, @ApprovedBy, @LedgerName, @Amount, @Purpose)
            `);

        const insertedId = result.recordset[0].Id;

        // ✅ IF TYPE = SUSPENSE → INSERT INTO SECOND TABLE
        if (Type === "Suspenses") {
            await pool.request()
                .input("VoucherNo", sql.VarChar, VoucherNo)
                .input("AdvanceAmount", sql.Decimal(18, 2), Amount)
                .query(`
                    INSERT INTO SuspenseEntry (VoucherNo, AdvanceAmount)
                    VALUES (@VoucherNo, @AdvanceAmount)
                `);
        }
// ✅ UPDATE CASH INVENTORY
if(Type === "Expenses") {
        await insertInventory(
            pool,
             req.body.VoucherNo.split("/")[0], // Assuming branch info is sent in request       
            VoucherNo,
            null,
            "Expense",
            Amount,
            true,
            ExpenseCategory,
            req.body.CreatedBy || req.body.VoucherNo.split("/")[0] // Fallback to branch code from voucher
        );
} else if(Type === "Receipt") {
       await insertInventory(
  pool,
  req.body.VoucherNo.split("/")[0],
  VoucherNo,
  null,
  "Receipt",
 Amount,
  false,
  ExpenseCategory,
    req.body.CreatedBy || req.body.VoucherNo.split("/")[0] // Fallback to branch code from voucher
);
} else  if(Type === "Suspenses") {
    await insertInventory(
        pool,
         req.body.VoucherNo.split("/")[0],
        VoucherNo,
        null,
        "SUSPENSE",
        Amount,
        true,
        ExpenseCategory,
        req.body.CreatedBy || req.body.VoucherNo.split("/")[0]
    );
}

res.status(200).json({
    message: "Saved Successfully",
    id: insertedId
});

    } catch (err) {
        console.error("EXPENSE INSERT ERROR:", err);

        res.status(500).json({
            message: "Server Error",
            error: err.message
        });
    }
});

router.get("/voucher/generate", async (req, res) => {
  try {
    const pool = await getConnection();

    const { branch, type } = req.query;

    // 🔍 Get last number
    const result = await pool.request()
      .input("branch", sql.VarChar, branch)
      .input("type", sql.VarChar, type)
      .query(`
        SELECT TOP 1 VoucherNo
        FROM CashboxExpenses
        WHERE VoucherNo LIKE @branch + '/' + @type + '/%'
        ORDER BY Id DESC
      `);

    let nextNumber = 1;

    if (result.recordset.length > 0) {
      const lastVoucher = result.recordset[0].VoucherNo;

      const lastNumber = parseInt(lastVoucher.split("/")[2]);
      nextNumber = lastNumber + 1;
    }

    // 🔥 FORMAT (001, 002...)
    const padded = String(nextNumber).padStart(3, "0");

    const voucher = `${branch}/${type}/${padded}`;

    res.json({ voucher });

  } catch (err) {
    console.log(err);
    res.status(500).send(err.message);
  }
});
//========================================== VOUCHER ==========================================

router.get("/voucher", async (req, res) => {
    try {
        console.log("Generating voucher number...");

        const pool = await getConnection();

        const result = await pool.request()
            .query("SELECT ISNULL(MAX(Id),0) + 1 AS nextId FROM CashboxExpenses");

        const next = result.recordset[0].nextId;

        return res.json({ voucher: "VCH" + next });

    } catch (err) {
        console.log("VOUCHER ERROR:", err);
        return res.status(500).json({ error: err.message });
    }
});
router.get("/categories", async (req, res) => {
    console.log("Fetching categories...");
    try {
        const pool = await getConnection();

        const result = await pool.request().query(`
            SELECT Id, ExpenseCategory, LedgerName 
            FROM ExpenseCategoryMaster
        `);

        res.json(result.recordset);

    } catch (err) {
        res.status(500).send(err.message);
    }
});


router.get("/suspense-active", async (req, res) => {
    try {
        const pool = await getConnection();

        const result = await pool.request().query(`
            SELECT * FROM SuspenseEntry
            WHERE (AdvanceAmount - UsedAmount) > 0
        `);

        res.json(result.recordset);

    } catch (err) {
        res.status(500).send(err.message);
    }
});
router.get("/suspense", async (req, res) => {
    try {
        const pool = await getConnection();

        const { voucher } = req.query;
console.log("Fetching suspense details for voucher:", voucher);
        const master = await pool.request()
            .input("VoucherNo", sql.VarChar, voucher)
            .query(`SELECT * FROM SuspenseEntry WHERE VoucherNo=@VoucherNo`);

        const details = await pool.request()
            .input("VoucherNo", sql.VarChar, voucher)
            .query(`SELECT * FROM SuspenseDetails WHERE VoucherNo=@VoucherNo`);

        res.json({
            master: master.recordset[0],
            details: details.recordset
        });

    } catch (err) {
        res.status(500).send(err.message);
    }
});
router.post("/suspense/save", async (req, res) => {
  try {
    const pool = await getConnection();
    const { VoucherNo, rows } = req.body;

    const branch = VoucherNo.split("/")[0];

    // 🔥 1. CHECK STATUS
    const check = await pool.request()
      .input("VoucherNo", sql.VarChar, VoucherNo)
      .query(`SELECT Status, AdvanceAmount FROM SuspenseEntry WHERE VoucherNo=@VoucherNo`);

    if (check.recordset[0]?.Status === "Completed") {
      return res.status(400).send("Already submitted!");
    }

    const advanceAmount = check.recordset[0].AdvanceAmount;

    // 🔥 2. GET LAST EXP VOUCHER (GLOBAL)
    const lastVoucher = await pool.request()
      .input("branch", sql.VarChar, branch)
      .query(`
        SELECT TOP 1 VoucherNo 
        FROM CashboxExpenses
        WHERE VoucherNo LIKE @branch + '/EXP/%'
        ORDER BY Id DESC
      `);

    let nextNo = 1;

    if (lastVoucher.recordset.length > 0) {
      const last = lastVoucher.recordset[0].VoucherNo;
      nextNo = parseInt(last.split("/")[2]) + 1;
    }

    let generatedIds = [];
    let totalUsed = 0;

    // 🔥 3. LOOP
    for (let row of rows) {

      const newVoucher = `${branch}/EXP/${String(nextNo).padStart(3, "0")}`;
      nextNo++;

      generatedIds.push(newVoucher);
      totalUsed += Number(row.Amount);

      // ✅ Insert SuspenseDetails
      await pool.request()
        .input("SuspenseId", sql.VarChar, newVoucher)
        .input("VoucherNo", sql.VarChar, VoucherNo)
        .input("ExpenseCategory", sql.VarChar, row.ExpenseCategory)
        .input("LedgerName", sql.VarChar, row.LedgerName)
        .input("Amount", sql.Decimal(18,2), row.Amount)
        .input("ApprovedBy", sql.VarChar, row.ApprovedBy)
        .query(`
          INSERT INTO SuspenseDetails
          (SuspenseId, VoucherNo, ExpenseCategory, LedgerName, Amount, ApprovedBy)
          VALUES
          (@SuspenseId, @VoucherNo, @ExpenseCategory, @LedgerName, @Amount, @ApprovedBy)
        `);

      // ✅ Insert CashboxExpenses
      await pool.request()
        .input("VoucherNo", sql.VarChar, newVoucher)
        .input("Type", sql.VarChar, "Expenses")
        .input("ExpenseCategory", sql.VarChar, row.ExpenseCategory)
        .input("EmployeeCode", sql.VarChar, null)
        .input("Date", sql.Date, new Date())
        .input("ApprovedBy", sql.VarChar, row.ApprovedBy)
        .input("LedgerName", sql.VarChar, row.LedgerName)
        .input("Amount", sql.Decimal(18,2), row.Amount)
        .input("Purpose", sql.VarChar, "From Suspense")
        .query(`
          INSERT INTO CashboxExpenses
          (VoucherNo, Type, ExpenseCategory, EmployeeCode, Date, ApprovedBy, LedgerName, Amount, Purpose)
          VALUES
          (@VoucherNo, @Type, @ExpenseCategory, @EmployeeCode, @Date, @ApprovedBy, @LedgerName, @Amount, @Purpose)
        `);
    }

    // 🔥 4. CALCULATE BALANCE
    const remaining = advanceAmount - totalUsed;

    if (remaining < 0) {
      return res.status(400).send("Amount exceeds advance!");
    }

    // 🔥 5. UPDATE MASTER
    await pool.request()
      .input("VoucherNo", sql.VarChar, VoucherNo)
      .input("UsedAmount", sql.Decimal(18,2), totalUsed)
      .input("RemainingAmount", sql.Decimal(18,2), remaining)
      .query(`
        UPDATE SuspenseEntry
        SET 
          UsedAmount = @UsedAmount,
          -- RemainingAmount = @RemainingAmount,
          Status = 'Completed'
        WHERE VoucherNo=@VoucherNo
      `);

    // 🔥 6. INVENTORY UPDATE

    // 👉 Expense (Debit)
    await insertInventory(
      pool,
      branch,
      VoucherNo,
      null,
      "SUSPENSE_USED",
      totalUsed,
      true,
      "Used from Suspense",
       VoucherNo.split("/")[0] 
    );

    // 👉 Remaining Return (Credit)
    if (remaining > 0) {
      await insertInventory(
        pool,
        branch,
        VoucherNo,
        null,
        "SUSPENSE_RETURN",
        remaining,
        false,
        "Returned unused suspense",
        VoucherNo.split("/")[0] 

      );
    }

    res.json({ ids: generatedIds });

  } catch (err) {
    console.log(err);
    res.status(500).send(err.message);
  }
});

router.get("/inventory/:branch", async (req, res) => {

  const pool = await getConnection();

  const result = await pool.request()
    .input("Branch", sql.VarChar, req.params.branch)
    .query(`
      SELECT * FROM CashInventory
      WHERE Branch=@Branch
      ORDER BY Id DESC
    `);

  res.json(result.recordset);
});


router.get("/cash-summary", async (req, res) => {
  const { fromDate, toDate } = req.query;
  const pool = await getConnection();

  const expenses = await pool.request()
    .input("fromDate", sql.Date, fromDate)
    .input("toDate", sql.Date, toDate)
    .query(`
      SELECT ISNULL(SUM(Amount),0) AS total
      FROM CashBoxExpenses
      WHERE Date BETWEEN @fromDate AND @toDate and Type in('Expenses')
    `);

  const suspense = await pool.request()
    .input("fromDate", sql.Date, fromDate)
    .input("toDate", sql.Date, toDate)
    .query(`
      SELECT ISNULL(SUM(AdvanceAmount),0) AS total
      FROM SuspenseEntry
      WHERE usedAmount > 0 and status <>'Completed'
      AND CreatedDate BETWEEN @fromDate AND @toDate
    `);

  res.json({
    expenses: expenses.recordset[0].total,
    suspense: suspense.recordset[0].total
  });
});


router.post("/cash-entry", async (req, res) => {
  const { fromDate, toDate, opening, expenses, suspense, handCash } = req.body;
  const pool = await getConnection();

  await pool.request()
    .input("fromDate", sql.Date, fromDate)
    .input("toDate", sql.Date, toDate)
    .input("opening", sql.Decimal, opening)
    .input("expenses", sql.Decimal, expenses)
    .input("suspense", sql.Decimal, suspense)
    .input("handCash", sql.Decimal, handCash)
    .input("status", sql.VarChar, "Pending L1")
    .query(`
      INSERT INTO CashEntry
      (FromDate, ToDate, Opening, Expenses, Suspense, HandCash, Status)
      VALUES (@fromDate, @toDate, @opening, @expenses, @suspense, @handCash, @status)
    `);

  res.send("Saved");
});
router.get("/cash-entry-list", async (req, res) => {
  try {
    const pool = await getConnection();

    const { branch } = req.query; // optional filter

    let query = `
      SELECT 
        Id,
       CONVERT(VARCHAR, FromDate, 105) AS FromDate,
  CONVERT(VARCHAR, ToDate, 105) AS ToDate,
        Opening,
        Expenses,
        Suspense,
        HandCash,
        Status,
        CreatedDate
      FROM CashEntry
    `;

    // 🔹 Branch Filter (if passed)
    if (branch) {
      query += ` WHERE Branch = @branch`;
    }

    query += ` ORDER BY Id DESC`;

    const request = pool.request();

    if (branch) {
      request.input("branch", sql.VarChar, branch);
    }

    const result = await request.query(query);

    res.json(result.recordset);

  } catch (err) {
    console.log("CASH ENTRY LIST ERROR:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.post("/approve-l1/:id", async (req, res) => {
  const pool = await getConnection();
  await pool.request()
    .input("id", sql.Int, req.params.id)
    .query(`UPDATE CashEntry SET Status='Approved L1' WHERE Id=@id`);
  res.send("L1 Approved");
});

router.post("/approve-l2/:id", async (req, res) => {
  const pool = await getConnection();
  await pool.request()
    .input("id", sql.Int, req.params.id)
    .query(`UPDATE CashEntry SET Status='Completed' WHERE Id=@id`);
  res.send("L2 Approved");
});
//========================================== EXPORT ==========================================

router.get("/expense-summary", async (req, res) => {
  try {
    const pool = await getConnection();

    let { fromDate, toDate } = req.query;

   
    // 🔥 Ensure proper JS Date conversion (important)
    fromDate = new Date(fromDate);
    toDate = new Date(toDate);
 console.log("FromDate - ToDate:", fromDate, "-", toDate);

    const result = await pool.request()
      .input("fromDate", sql.Date, fromDate)
      .input("toDate", sql.Date, toDate)
      .query(`
        SELECT 
          ExpenseCategory,
          SUM(Amount) AS TotalAmount
        FROM CashboxExpenses
        WHERE Type in('Expenses')
          AND Date >= @fromDate
          AND Date < DATEADD(DAY, 1, @toDate)
        GROUP BY ExpenseCategory
        ORDER BY ExpenseCategory
      `);

    console.log("Result:", result.recordset);

    res.json(result.recordset);

  } catch (err) {
    console.log("SUMMARY ERROR:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;