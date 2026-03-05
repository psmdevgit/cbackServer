const express = require("express");
const router = express.Router();
const { sql, getConnection } = require("../db");
const axios = require("axios");

//==========================================   started   ==================================================================

router.post("/login", async (req, res) => {
   try {
        const { username, password } = req.body;

        console.log(username,password);

        const pool = await getConnection();

        const query = `SELECT id, username, role, branch FROM pettyusers
                WHERE username COLLATE SQL_Latin1_General_CP1_CS_AS = @username AND passcode COLLATE SQL_Latin1_General_CP1_CS_AS = @password`

        const result = await pool.request()
            .input("username", sql.VarChar, username.toUpperCase())
            .input("password", sql.VarChar, password)
            .query(query);


            console.log(result)
        if (result.rowsAffected > 0) {
            res.json({
                status: "success",
                data: result.recordset[0]
            });
        } else {
            res.status(401).json({
                status: "fail",
                message: "Invalid username or password"
            });
        }

    } catch (error) {
        console.log("LOGIN ERROR:", error);

        res.status(500).json({
            status: "error",
            message: "server issue"
        });
    }
});



//============================================================================================================
module.exports = router;
