const express = require("express");
const app = express();
const path = require("path");
const route = require("./routes/routes.routes");
const expressLayouts = require("express-ejs-layouts");
const session = require("express-session");
const ejs = require("ejs").__express;

require("dotenv").config("config.env");

const fs = require("fs");
var https = require("https");

const port = process.env.PORT || 7776;

require("dotenv").config();
app.use(express.static(__dirname + "/public"));

app.set("views", path.join(__dirname, "views/layouts"));

app.use(express.json());
app.use(
  session({ resave: false, saveUninitialized: true, secret: "nodedemo" })
);

app.set("layout", "index");
app.set("view engine", "ejs");
app.engine("ejs", ejs);
app.use(expressLayouts);

app.use("/", route);

// --------- ( For deployment use ) ------------

// https 
//   .createServer(
//     {
//       key: fs.readFileSync("sslcert/ssl.key"),
//       cert: fs.readFileSync("sslcert/ssl.cert"),
//     },
//     app
//   )
//   .listen(port, function () {
//     console.log(
//       "Server is up and running on port number " + port + " for Https"
//     );
//   });

// --------- ( For deployment use end ) ------------ //

// -------------- (For Development use ) ----------------------

app.listen(port, () => console.log(`server is running on ${port}`))

// -------------- (For Development use end) ---------------------- //
