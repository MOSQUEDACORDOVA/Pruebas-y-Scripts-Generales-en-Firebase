const functions = require("firebase-functions");
const https = require("https");
const cors = require("cors");

// Inicializa cors
const corsOptions = {
  origin: "*", // Permitir todos los orígenes; cambia esto según sea necesario
};

exports.nuevaInstalacionTiendaNube = functions.https.onRequest((req, res) => {
  // Usa cors como middleware
  cors(corsOptions)(req, res, () => {
    const {code} = req.body;

    if (!code) {
      return res.status(400).json({
        messageCF: "El parámetro 'code' es obligatorio",
      });
    }

    const data = JSON.stringify({
      client_id: "9756",
      client_secret: "92047fb27dc116d8b69a5814d70c3b5ddb5dfc9208614c04",
      grant_type: "authorization_code",
      code: code,
    });

    const options = {
      hostname: "www.tiendanube.com",
      path: "/apps/authorize/token",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      },
    };

    const request = https.request(options, (response) => {
      let responseData = "";

      response.on("data", (chunk) => {
        responseData += chunk;
      });

      response.on("end", () => {
        const statusCode = response.statusCode;
        const jsonResponse = {
          messageCF: statusCode === 200 ?
            "Proceso de solicitud de token" :
            "Error al ejecutar la Cloud Function",
          respuesta: statusCode === 200 ?
          JSON.parse(responseData) : responseData,
        };
        res.status(statusCode).json(jsonResponse);
      });
    });

    request.on("error", (error) => {
      res.status(500).json({
        messageCF: "Error al ejecutar la Cloud Function",
        respuesta: error.message,
      });
    });

    request.write(data);
    request.end();
  });
});

exports.obtenerProductosTiendaNube = functions.https.onRequest((req, res) => {
  // Usa cors como middleware
  cors(corsOptions)(req, res, () => {
    const {token} = req.body;

    if (!token) {
      return res.status(400).json({
        messageCF: "El parámetro 'token' es obligatorio",
      });
    }

    const options = {
      hostname: "api.tiendanube.com",
      path: "/v1/4911251/products",
      method: "GET",
      headers: {
        "Authentication": `bearer ${token}`,
        "User-Agent": "SistemaNube/1.0",
      },
    };

    const request = https.request(options, (response) => {
      let responseData = "";

      response.on("data", (chunk) => {
        responseData += chunk;
      });

      response.on("end", () => {
        const products = JSON.parse(responseData);
        const simplifiedProducts = products.map((product) => ({
          name: product.name.es,
          image: product.images.length > 0 ? product.images[0].src : null,
        }));
        res.status(response.statusCode).json({data: simplifiedProducts});
      });
    });

    request.on("error", (error) => {
      res.status(500).json({
        messageCF: "Error al ejecutar la Cloud Function",
        respuesta: error.message,
      });
    });

    request.end();
  });
});


