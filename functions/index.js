const functions = require("firebase-functions/v2");
const admin = require("firebase-admin");

const https = require("https");
const cors = require("cors");

admin.initializeApp();
const db = admin.firestore();

// Inicializa cors
const corsOptions = {
  origin: "*", // Permitir todos los orígenes; cambia esto según sea necesario
};

exports.nuevaInstalacionTiendaNube = functions.https.onRequest((req, res) => {
  cors(corsOptions)(req, res, () => {
    const {code} = req.body;

    if (!code) {
      return res.status(400).json({
        messageCF: "El parámetro 'code' es obligatorio",
      });
    }

    const data = JSON.stringify({
      client_id: "16132",
      client_secret: "232531c4b99e6a958849e3a5c78ca691bbce9d4c05837ab8",
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
            JSON.parse(responseData) :
            responseData,
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

exports.webhookOrderPaid = functions.https.onRequest((req, res) => {
  cors(corsOptions)(req, res, async () => {
    const orderData = req.body;

    try {
    // TEST await db.collection("logs_firebase_functions").doc().set(orderData);
      const ordersQuery = await db
          .collection("orders")
          .where("id", "==", orderData.id)
          .get();

      if (!ordersQuery.empty) {
        return res.status(400).json({
          messageCF: "La orden ya ha sido registrada previamente",
        });
      }

      await db.collection("orders").add({
        ...orderData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Respuesta exitosa
      res.status(200).json({
        messageCF: "Orden procesada y registrada exitosamente",
      });
    } catch (error) {
      await db.collection("logs_firebase_functions").doc().set({
        error: error.message,
        stack: error.stack,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(500).json({
        messageCF: "Error al procesar la orden",
        error: error.message,
      });
    }
  });
});

exports.detectarNuevoDocumentoEnOrders = functions.firestore.onDocumentCreated(
    "orders/{orderId}",
    async (event) => {
      try {
        const orderData = event.data.data();

        // Buscar la tienda asociada al store_id
        const tiendaDoc = await db
            .collection("tiendas")
            .where("user_id", "==", orderData.store_id)
            .limit(1)
            .get();

        if (tiendaDoc.empty) {
          console.error("No se encontró la tienda asociada al store_id");
          return;
        }

        const tiendaData = tiendaDoc.docs[0].data();
        const tiendaToken = tiendaData.token;

        const options = {
          hostname: "api.tiendanube.com",
          path: `/v1/${orderData.store_id}/orders/${orderData.id}`,
          method: "GET",
          headers: {
            "Authentication": `bearer ${tiendaToken}`,
            "User-Agent": "SistemaNube/1.0",
          },
        };

        const request = https.request(options, (response) => {
          let responseData = "";

          response.on("data", (chunk) => {
            responseData += chunk;
          });

          response.on("end", async () => {
            if (response.statusCode === 200) {
              const orderDetails = JSON.parse(responseData);

              const clienteRef = await (async () => {
                const clienteQuery = await db.collection("clientes")
                    .where("LsCustomer", "==", orderDetails.customer.id)
                    .limit(1)
                    .get();
                return clienteQuery.empty ? null : clienteQuery.docs[0].ref;
              })();

              await db.collection("historial_puntos").add({
                puntos: orderDetails.total * tiendaData.equivalencia_puntos,
                tienda: tiendaDoc.docs[0].ref,
                cliente: clienteRef,
                tipo: true,
                order_id: orderDetails.id,
                orden: event.data.ref,
                equivalencia: tiendaData.equivalencia_puntos,
              });

              // Agregar puntos al cliente
              if (clienteRef) {
                await clienteRef.update({
                  puntos: admin.firestore.FieldValue.increment(
                      orderDetails.total * tiendaData.equivalencia_puntos,
                  ),
                });
              }

              // Actualización de la orden
              await event.data.ref.update({
                total: orderDetails.total,
                customer_id: orderDetails.customer.id,
                tienda: tiendaDoc.docs[0].ref,
                cliente: clienteRef,
              });
            } else {
              console.error("Error al obtener el total de la orden", {
                token: tiendaToken,
                respuesta: responseData,
              });
            }
          });
        });

        request.on("error", async (error) => {
          await db.collection("logs_firebase_functions").doc().set({
            error: error.message,
            stack: error.stack,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.error("Error al procesar la orden", error.message);
        });

        request.end();
      } catch (error) {
        console.error(
            `Error en detectarNuevoDocumentoEnOrders: ${error.message}`,
        );
      }
    },
);
