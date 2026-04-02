const express = require("express");
const router = express.Router();
const { sql, getConnection } = require("../db");
const { NVarChar } = require("mssql");
const ExcelJS = require("exceljs");

router.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        const pool = await getConnection();

        const result = await pool.request()
            .input("username", sql.VarChar, username)
            .input("password", sql.VarChar, password)
            .query(`
                SELECT id, username, role, branch, branchCode 
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

router.get("/last-entry-date", async (req, res) => {
  try {
    const pool = await getConnection();
    const { branch } = req.query;

    const result = await pool.request()
      .input("Branch", sql.VarChar, branch)
      .query(`
        SELECT TOP 1 ToDate 
        FROM CashEntry 
        WHERE Branch = @Branch 
        ORDER BY CreatedDate DESC
      `);

    if (result.recordset.length > 0) {
      res.json({ lastDate: result.recordset[0].ToDate });
    } else {
      res.json({ lastDate: null });
    }

  } catch (err) {
    console.log(err);
    res.status(500).send("Error fetching last entry date");
  }
});

const getEmpCode = async (pool, voucherNo) => {
  const result = await pool.request()
    .input("voucher", sql.VarChar, voucherNo)
    .query(`
      SELECT EmployeeCode
      FROM CashboxExpenses
      WHERE VoucherNo = @voucher
    `);

  if (result.recordset.length > 0) {
    return result.recordset[0].EmployeeCode;
  }

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

//  const openingNum = Number(opening);
// const debitNum = Number(debit);
// const creditNum = Number(credit);


// const closing = openingNum - debitNum + creditNum;

  const openingNum = Number(opening);
  const debitNum = Number(debit);
  const creditNum = Number(credit);

  let closing = 0;

  // ✅ Custom logic
  if (type === "SUSPENSE_USED") {
    // ❌ No balance change
    closing = openingNum;
  } 
  else if (type === "SUSPENSE_RETURN") {
    // ✅ Add returned amount
    closing = openingNum + creditNum;
  } 
  else {
    // ✅ Default logic
    closing = openingNum - debitNum + creditNum;
  }

  console.log("closing - ", closing);

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
            Purpose,Branch
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
            .input("Branch", sql.VarChar, Branch)
            .query(`
                INSERT INTO CashboxExpenses
                (VoucherNo, Type, ExpenseCategory, EmployeeCode, Date, ApprovedBy, LedgerName, Amount, Purpose, branch)
                OUTPUT INSERTED.Id
                VALUES
                (@VoucherNo, @Type, @ExpenseCategory, @EmployeeCode, @Date, @ApprovedBy, @LedgerName, @Amount, @Purpose, @Branch)
            `);

        const insertedId = result.recordset[0].Id;

        // ✅ IF TYPE = SUSPENSE → INSERT INTO SECOND TABLE
        if (Type === "Suspenses") {
            await pool.request()
                .input("VoucherNo", sql.VarChar, VoucherNo)
                .input("AdvanceAmount", sql.Decimal(18, 2), Amount)
                .input("Branch", sql.VarChar, Branch)
                .query(`
                    INSERT INTO SuspenseEntry (VoucherNo, AdvanceAmount, branch)
                    VALUES (@VoucherNo, @AdvanceAmount, @Branch)
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
    message: `${Type} Saved Successfully`,
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

        
        const { branch } = req.query;

        const result = await pool.request()
            .input("Branch", sql.VarChar, branch)
            .query(`
            SELECT * FROM SuspenseEntry
            WHERE status is null  and branch = @Branch
        `);

        // (AdvanceAmount - UsedAmount) > 0 and

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
    const { VoucherNo, rows, narration } = req.body;

    const branch = VoucherNo.split("/")[0];

    // console.log(VoucherNo,rows,branch);

    
  const EmployeeCode = await getEmpCode(pool, VoucherNo);


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
        .input("Narration", sql.VarChar, narration)
        .input("Branch", sql.VarChar, branch)
        .query(`
          INSERT INTO SuspenseDetails
          (SuspenseId, VoucherNo, ExpenseCategory, LedgerName, Amount, ApprovedBy, Branch, Narration)
          VALUES
          (@SuspenseId, @VoucherNo, @ExpenseCategory, @LedgerName, @Amount, @ApprovedBy, @Branch, @Narration)
        `);

      // ✅ Insert CashboxExpenses
      await pool.request()
        .input("VoucherNo", sql.VarChar, newVoucher)
        .input("Type", sql.VarChar, "Expenses")
        .input("ExpenseCategory", sql.VarChar, row.ExpenseCategory)
        .input("EmployeeCode", sql.VarChar, EmployeeCode)
        .input("Date", sql.Date, new Date())
        .input("ApprovedBy", sql.VarChar, row.ApprovedBy)
        .input("LedgerName", sql.VarChar, row.LedgerName)
        .input("Amount", sql.Decimal(18,2), row.Amount)
        .input("Purpose", sql.VarChar, narration?.trim() || "From Suspense")
        .input("Branch", sql.VarChar, branch)
        .query(`
          INSERT INTO CashboxExpenses
          (VoucherNo, Type, ExpenseCategory, EmployeeCode, Date, ApprovedBy, LedgerName, Amount, Purpose, branch)
          VALUES
          (@VoucherNo, @Type, @ExpenseCategory, @EmployeeCode, @Date, @ApprovedBy, @LedgerName, @Amount, @Purpose, @Branch)
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
          --RemainingAmount = @RemainingAmount,
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

  const { fromDate, toDate } = req.query;

  try {
    const request = pool.request()
      .input("Branch", sql.VarChar, req.params.branch);

    let query = `
      SELECT * FROM CashInventory
      WHERE Branch = @Branch
    `;

    // 🔥 Apply Date Filter
    if (fromDate && toDate) {
      query += `
        AND CAST(TranDate AS DATE) BETWEEN @FromDate AND @ToDate
      `;

      request
        .input("FromDate", sql.Date, fromDate)
        .input("ToDate", sql.Date, toDate);
    }

    query += ` ORDER BY Id DESC`;

    const result = await request.query(query);

    res.json(result.recordset);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});
// router.get("/dailyTransactions", async (req, res) => {
//   const pool = await getConnection();
//   try {
//     let { fromDate, toDate, branch } = req.query;
//     branch = branch ? branch.trim() : null;

//     console.log(fromDate,toDate,branch);

//     const request = pool.request();

//     // let query = `SELECT * FROM CashInventory WHERE 1=1`;

//     let query = `  select CI.id as Id,
// 	  CI.Branch as Branch,
// 	  CI.TranDate as TranDate,
// 	  CI.VoucherNo as VoucherNo,
// 	  CI.RefVoucherNo as RefVoucherNo,
// 	  CI.TranType as TranType,
// 	  CI.Description as Description,
// 	  CE.LedgerName as LedgerName,
// 	  CI.Debit as Debit,
// 	  CI.Credit as Credit,
// 	  Ci.OpeningBalance as OpeningBalance,
// 	  CI.ClosingBalance as ClosingBalance,
// 	  CI.CreatedBy as CreatedBy
// 	  from CashInventory CI
// 	  inner join CashboxExpenses CE on CE.VoucherNo = CI.VoucherNo WHERE 1=1`

//     if (branch) {
//       query += ` AND CI.Branch = @branch`;
//       request.input("branch", sql.NVarChar, branch);
//     }

//     if (fromDate && toDate) {
//       query += ` AND CAST(CI.TranDate AS DATE) BETWEEN @FromDate AND @ToDate`;
//       request.input("FromDate", sql.Date, fromDate);
//       request.input("ToDate", sql.Date, toDate);
//     }

//     query += ` ORDER BY CI.Id DESC`;

//     const result = await request.query(query);
//     res.json(result.recordset);

//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Server Error");
//   }
// });

router.get("/dailyTransactions", async (req, res) => {
  const pool = await getConnection();
  try {
    let { fromDate, toDate, branch } = req.query;
    branch = branch ? branch.trim() : null;

    console.log(fromDate,toDate,branch);

    const request = pool.request();

    // let query = `SELECT * FROM CashInventory WHERE 1=1`;

    let query = `  
	select CI.id as Id,
	  CI.branch as Branch,
	  CI.Date as TranDate,
	  CI.VoucherNo as VoucherNo,
	  CI.EmployeeCode as EmpID,
	  CI.Type as TranType,
	  CI.ExpenseCategory as Description,
	  CI.LedgerName as LedgerName,
	  CI.Amount as Amount,
	  CI.Purpose as Purpose
	  from CashboxExpenses CI WHERE 1=1`

    if (branch) {
      query += ` AND CI.Branch = @branch`;
      request.input("branch", sql.NVarChar, branch);
    }

    if (fromDate && toDate) {
      query += ` AND CAST(CI.Date AS DATE) BETWEEN @FromDate AND @ToDate`;
      request.input("FromDate", sql.Date, fromDate);
      request.input("ToDate", sql.Date, toDate);
    }

    query += ` ORDER BY CI.Id DESC`;

    const result = await request.query(query);
    res.json(result.recordset);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// router.get("/allSuspenses", async (req, res) => {
//   const pool = await getConnection();
//   try {
//     let { fromDate, toDate, branch } = req.query;
//     branch = branch ? branch.trim() : null;

//     console.log(fromDate,toDate,branch);

//     const request = pool.request();

//     // let query = `SELECT * FROM CashInventory WHERE 1=1`;

//     let query = `  
// 		 SELECT 
//     --CONVERT(VARCHAR, SD.CreatedDate, 105) AS Date,
//     SD.CreatedDate AS Date,
//     SD.VoucherNo AS VoucherNo,
// 	  SD.SuspenseId AS ExpenseID,
//     SD.ExpenseCategory AS Description,
//     SD.LedgerName AS LedgerName,
//     SE.AdvanceAmount AS AdvAmount,
//     SD.Amount AS UsedAmount,
//     SE.branch AS Branch,
//     SD.ApprovedBy AS Approved,
//     SE.status AS Status
// FROM SuspenseDetails SD
// INNER JOIN SuspenseEntry SE 
//     ON SE.VoucherNo = SD.VoucherNo where 1=1`

//     if (branch) {
//       query += ` AND SE.branch = @branch`;
//       request.input("branch", sql.NVarChar, branch);
//     }

//     if (fromDate && toDate) {
//       query += ` AND CAST(SD.CreatedDate AS DATE) BETWEEN @FromDate AND @ToDate`;
//       request.input("FromDate", sql.Date, fromDate);
//       request.input("ToDate", sql.Date, toDate);
//     }

//     query += ` ORDER BY SD.id DESC`;

//     const result = await request.query(query);
//     res.json(result.recordset);

//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Server Error");
//   }
// });

router.get("/allSuspenses", async (req, res) => {
  const pool = await getConnection();
  try {
    let { fromDate, toDate, branch } = req.query;
    branch = branch ? branch.trim() : null;


    const request1 = pool.request(); // for completed
    const request2 = pool.request(); // for pending

    // ================= COMPLETED =================
    let queryCompleted = `  
      SELECT 
        SD.CreatedDate AS Date,
        SD.VoucherNo AS VoucherNo,
        SD.SuspenseId AS ExpenseID,
        SD.ExpenseCategory AS Description,
        SD.LedgerName AS LedgerName,
        SE.AdvanceAmount AS AdvAmount,
        SD.Amount AS UsedAmount,
        SE.RemainingAmount AS Balance,
        SD.branch AS Branch,
        SD.ApprovedBy AS Approved,
        'Completed' AS Status,
		    Cb.EmployeeCode AS EmpID
      FROM SuspenseDetails SD
      INNER JOIN SuspenseEntry SE 
        ON SE.VoucherNo = SD.VoucherNo
      inner join CashboxExpenses CB
		    on CB.VoucherNo = SD.VoucherNo
      WHERE 1=1
    `;

    if (branch) {
      queryCompleted += ` AND SD.branch = @branch`;
      request1.input("branch", sql.NVarChar, branch);
    }

    if (fromDate && toDate) {
      queryCompleted += ` AND CAST(SD.CreatedDate AS DATE) BETWEEN @FromDate AND @ToDate`;
      request1.input("FromDate", sql.Date, fromDate);
      request1.input("ToDate", sql.Date, toDate);
    }

    queryCompleted += ` ORDER BY SD.id DESC`;

    const completedResult = await request1.query(queryCompleted);

    // ================= PENDING =================
    let queryPending = `  
      SELECT 
        SE.CreatedDate AS Date,
        SE.VoucherNo AS VoucherNo,
        '-' AS ExpenseID,
        CB.ExpenseCategory AS Description,
        CB.LedgerName AS LedgerName,
        SE.AdvanceAmount AS AdvAmount,
        SE.UsedAmount AS UsedAmount,
        SE.RemainingAmount AS Balance,
        SE.branch AS Branch,
        CB.ApprovedBy AS Approved,
        'Pending' AS Status,
		Cb.EmployeeCode AS EmpID
      FROM SuspenseEntry SE
      INNER JOIN CashboxExpenses CB 
        ON CB.VoucherNo = SE.VoucherNo
      WHERE SE.RemainingAmount > 0
    `;

    if (branch) {
      queryPending += ` AND SE.branch = @branch`;
      request2.input("branch", sql.NVarChar, branch);
    }

    if (fromDate && toDate) {
      queryPending += ` AND CAST(SE.CreatedDate AS DATE) BETWEEN @FromDate AND @ToDate`;
      request2.input("FromDate", sql.Date, fromDate);
      request2.input("ToDate", sql.Date, toDate);
    }

    queryPending += ` ORDER BY SE.id DESC`;

    const pendingResult = await request2.query(queryPending);

    // ================= RESPONSE =================
    res.json({
      completed: completedResult.recordset,
      pending: pendingResult.recordset
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.get("/cash-summary", async (req, res) => {
  const { fromDate, toDate , userbranch} = req.query;
  const pool = await getConnection();

  console.log(req.query);

  const expenses = await pool.request()
    .input("fromDate", sql.Date, fromDate)
    .input("toDate", sql.Date, toDate)
    .input("branch", sql.NVarChar, userbranch)
    .query(`
      SELECT ISNULL(SUM(Amount),0) AS total
      FROM CashBoxExpenses
      WHERE branch = @branch AND Date BETWEEN @fromDate AND @toDate and Type in('Expenses')
    `);

  const suspense = await pool.request()
    .input("fromDate", sql.Date, fromDate)
    .input("toDate", sql.Date, toDate)
    .input("branch", sql.NVarChar, userbranch)
    .query(`
      SELECT ISNULL(SUM(AdvanceAmount),0) AS total
      FROM SuspenseEntry
      WHERE  branch = @branch AND usedAmount = 0 and status is null
      AND cast(CreatedDate as date) BETWEEN @fromDate AND @toDate
    `);

  res.json({
    expenses: expenses.recordset[0].total,
    suspense: suspense.recordset[0].total
  });
});


router.post("/cash-entry", async (req, res) => {
  const { fromDate, toDate, opening, expenses, suspense, handCash, userbranch} = req.body;
  const pool = await getConnection();

  await pool.request()
    .input("fromDate", sql.Date, fromDate)
    .input("toDate", sql.Date, toDate)
    .input("opening", sql.Decimal, opening)
    .input("expenses", sql.Decimal, expenses)
    .input("suspense", sql.Decimal, suspense)
    .input("handCash", sql.Decimal, handCash)
    .input("status", sql.VarChar, "Pending L1")
    .input("branch", sql.VarChar, userbranch)
    .query(`
      INSERT INTO CashEntry
      (FromDate, ToDate, Opening, Expenses, Suspense, HandCash, Status, Branch)
      VALUES (@fromDate, @toDate, @opening, @expenses, @suspense, @handCash, @status, @branch)
    `);

  res.send("Saved");
});


// router.get("/cash-entry-list", async (req, res) => {
//   try {
//     const pool = await getConnection();

//     const { branch } = req.query; // optional filter

//     let query = `
//       SELECT 
//         Id,
//        CONVERT(VARCHAR, FromDate, 105) AS FromDate,
//   CONVERT(VARCHAR, ToDate, 105) AS ToDate,
//         Opening,
//         Expenses,
//         Suspense,
//         HandCash,
//         Status,
//         CreatedDate
//       FROM CashEntry
//     `;

//     // 🔹 Branch Filter (if passed)
//     if (branch) {
//       query += ` WHERE Branch = @branch`;
//     }

//     query += ` ORDER BY Id DESC`;

//     const request = pool.request();

//     if (branch) {
//       request.input("branch", sql.VarChar, branch);
//     }

//     const result = await request.query(query);

//     res.json(result.recordset);

//   } catch (err) {
//     console.log("CASH ENTRY LIST ERROR:", err);
//     res.status(500).json({
//       status: "error",
//       message: err.message
//     });
//   }
// });


router.get("/cash-entry-list", async (req, res) => {
  try {
    const pool = await getConnection();

    const { branch, fromDate, toDate } = req.query;

    console.log(branch, fromDate, toDate);

    let query = `
      SELECT 
        Id,
		    branch,
        CONVERT(VARCHAR, FromDate, 105) AS FromDate,
        CONVERT(VARCHAR, ToDate, 105) AS ToDate,
        Opening,
        Expenses,
        Suspense,
        HandCash,
        Status,
        CreatedDate
      FROM CashEntry
      WHERE 1=1
    `;
    // console.log(query);

    const request = pool.request();

    // 🔹 Branch Filter
    if (branch) {
      query += ` AND Branch = @branch`;
      request.input("branch", sql.VarChar, branch);
    }

    // 🔹 From Date Filter
    if (fromDate) {
      query += ` AND CAST(FromDate AS DATE) >= @fromDate`;
      request.input("fromDate", sql.Date, fromDate);
    }

    // 🔹 To Date Filter
    if (toDate) {
      query += ` AND CAST(ToDate AS DATE) <= @toDate`;
      request.input("toDate", sql.Date, toDate);
    }

    query += ` ORDER BY Id DESC`;

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

    let { fromDate, toDate, branch } = req.query;

   
    // 🔥 Ensure proper JS Date conversion (important)
    fromDate = new Date(fromDate);
    toDate = new Date(toDate);
 console.log("FromDate - ToDate:", fromDate, "-", toDate, branch);

    const result = await pool.request()
      .input("fromDate", sql.Date, fromDate)
      .input("toDate", sql.Date, toDate)
      .input("branch", sql.NVarChar, branch)
      .query(`
        SELECT 
          ExpenseCategory,
          SUM(Amount) AS TotalAmount
        FROM CashboxExpenses
        WHERE Type in('Expenses')
          AND Date >= @fromDate
          AND Date < DATEADD(DAY, 1, @toDate)
          AND branch = @branch
        GROUP BY ExpenseCategory
        ORDER BY ExpenseCategory
      `);

      // console.log(query);
    console.log("Result:", result.recordset);

    res.json(result.recordset);

  } catch (err) {
    console.log("SUMMARY ERROR:", err);
    res.status(500).send(err.message);
  }
});


//=======================================   Update transaction Description    ================

router.post("/updateDescription", async (req, res) => {
  try {
    const pool = await getConnection();

    const now = new Date();
    
    // const { id } = req.params;
    const { DescriptionId, DescriptionValue, existDescription,existLedgerName, VoucherNo, newAmount,newPurpose,Amount,Purpose } = req.body;

    console.log(req.body);

    if (VoucherNo == '' || DescriptionValue == '' ) {
      return res.status(400).json({ message: "Description is required" });
    }

    let newLedgerName = '';
    
     const nLedgerName = await pool.request()
    .input("id", sql.Int, DescriptionId)
    .query(`
      SELECT LedgerName 
      FROM ExpenseCategoryMaster 
      WHERE id = @id
    `);

    if (nLedgerName.recordset.length > 0) {
      newLedgerName = nLedgerName.recordset[0].LedgerName;
    }

    await pool.request()
      .input("vNo", sql.NVarChar, VoucherNo.trim())
      .input("Description", sql.NVarChar, DescriptionValue)
      .input("LedgerName", sql.NVarChar, newLedgerName)
      .input("ExistDesc", sql.NVarChar, existDescription)
      .input("ExistLedger", sql.NVarChar, existLedgerName)
      .input("today", sql.DateTime, now)
      .query(`
        UPDATE CashInventory
        SET Description = @Description,
        LedgerName = @LedgerName,
        ExistDescription = @ExistDesc,
        ExistLedgerName = @ExistLedger,
        DescUpdateTime = @today
        WHERE VoucherNo = @vNo
      `);

      await pool.request()
      .input("vNo", sql.NVarChar, VoucherNo.trim())
      .input("Description", sql.NVarChar, DescriptionValue)
      .input("LedgerName", sql.NVarChar, newLedgerName)
      .input("ExistDesc", sql.NVarChar, existDescription)
      .input("ExistLedger", sql.NVarChar, existLedgerName)
      .input("ExistAmount", sql.Int, parseFloat(Amount))
      .input("ExistPurpose", sql.NVarChar, Purpose)
      .input("Amount", sql.Int, parseFloat(newAmount))
      .input("Purpose", sql.NVarChar, newPurpose)
      .input("today", sql.DateTime, now)
      .query(`
        UPDATE CashboxExpenses
        SET ExpenseCategory = @Description,
        LedgerName = @LedgerName,
        ExistCategory = @ExistDesc,
        ExistLedgerName = @ExistLedger,
        Amount = @Amount,
        Purpose = @Purpose,
        ExistAmount = @ExistAmount,
        ExistPurpose = @ExistPurpose,
        DescUpdateTime = @today
        WHERE VoucherNo = @vNo
      `);

       await pool.request()
      .input("vNo", sql.NVarChar, VoucherNo.trim())
      .input("Description", sql.NVarChar, DescriptionValue)
      .input("ExistDesc", sql.NVarChar, existDescription)
      .input("LedgerName", sql.NVarChar, newLedgerName)
      .input("ExistLedger", sql.NVarChar, existLedgerName)
      .input("today", sql.DateTime, now)
      .query(`
        UPDATE SuspenseDetails
        SET ExpenseCategory = @Description,
        LedgerName = @LedgerName,
        ExistCategory = @ExistDesc,
        ExistLedgerName = @ExistLedger,
        DescUpdateTime = @today
        WHERE VoucherNo = @vNo
      `);

    res.json({ success: true, message: "Description updated successfully" });

  } catch (err) {
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});



router.post("/expense-report", async (req, res) => {
  try {

    console.log("Generating expense report with filters:", req.body);
    const { branch, category, fromDate, toDate } = req.body;

    const pool = await getConnection();

    // Step 1: Get dynamic branches
    let branchQuery = `
      SELECT DISTINCT Branch 
      FROM CashboxExpenses
    `;

    const branchResult = await pool.request().query(branchQuery);

    const branches = branchResult.recordset.map(b => `[${b.Branch}]`).join(",");

    // Step 2: Build dynamic pivot query
    let query = `
      SELECT ExpenseCategory, ${branches}
      FROM
      (
        SELECT ExpenseCategory, Branch, Amount
        FROM CashboxExpenses
        WHERE ExpenseCategory <> 'Suspenses'
        ${branch ? "AND Branch = @Branch" : ""}
        ${category ? "AND ExpenseCategory = @Category" : ""}
        ${fromDate ? "AND CAST(Date AS DATE) >= @FromDate" : ""}
        ${toDate ? "AND CAST(Date AS DATE) <= @ToDate" : ""}
      ) AS SourceTable
      PIVOT
      (
        SUM(Amount)
        FOR Branch IN (${branches})
      ) AS PivotTable
      ORDER BY ExpenseCategory
    `;

    const request = pool.request();

    if (branch) request.input("Branch", sql.VarChar, branch);
    if (category) request.input("Category", sql.VarChar, category);
    if (fromDate) request.input("FromDate", sql.Date, fromDate);
    if (toDate) request.input("ToDate", sql.Date, toDate);

    const result = await request.query(query);

    res.json(result.recordset);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.get("/filters", async (req, res) => {
  try {
    const pool = await getConnection();

    const branches = await pool.request().query(`
      SELECT DISTINCT Branch FROM CashboxExpenses
    `);

    const categories = await pool.request().query(`
      SELECT DISTINCT ExpenseCategory FROM CashboxExpenses
      WHERE ExpenseCategory <> 'Suspenses'
    `);

    res.json({
      branches: branches.recordset.map(b => b.Branch),
      categories: categories.recordset.map(c => c.ExpenseCategory)
    });

  } catch (err) {
    res.status(500).send(err.message);
  }
});


router.get("/export-excel", async (req, res) => {

  console.log("Exporting Excel with filters:", req.query);  
  try {
    const { branch, category, fromDate, toDate } = req.query;

    const pool = await getConnection();

    // same pivot logic
    const branchResult = await pool.request().query(`
      SELECT DISTINCT Branch FROM CashboxExpenses
    `);

    const branches = branchResult.recordset.map(b => `[${b.Branch}]`).join(",");

    let query = `
      SELECT ExpenseCategory, ${branches}
      FROM
      (
        SELECT ExpenseCategory, Branch, Amount
        FROM CashboxExpenses
        WHERE ExpenseCategory <> 'Suspenses'
        ${branch ? "AND Branch = @Branch" : ""}
        ${category ? "AND ExpenseCategory = @Category" : ""}
        ${fromDate ? "AND CAST(Date AS DATE) >= @FromDate" : ""}
        ${toDate ? "AND CAST(Date AS DATE) <= @ToDate" : ""}
      ) AS SourceTable
      PIVOT
      (
        SUM(Amount)
        FOR Branch IN (${branches})
      ) AS PivotTable
    `;

    const request = pool.request();

    if (branch) request.input("Branch", sql.VarChar, branch);
    if (category) request.input("Category", sql.VarChar, category);
    if (fromDate) request.input("FromDate", sql.Date, fromDate);
    if (toDate) request.input("ToDate", sql.Date, toDate);

    const result = await request.query(query);

    // Create Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Report");

    const data = result.recordset;

    if (data.length > 0) {
      worksheet.columns = Object.keys(data[0]).map(key => ({
        header: key,
        key: key,
        width: 20
      }));

      data.forEach(row => worksheet.addRow(row));
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=ExpenseReport.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error(err);
    res.status(500).send("Error exporting Excel");
  }
});
module.exports = router;