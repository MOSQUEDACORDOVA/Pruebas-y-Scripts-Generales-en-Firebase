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
        if (statusCode === 200) {
          const tokenData = JSON.parse(responseData);

          // Crear webhook automáticamente después de obtener el token
          crearWebhookTiendaNube(tokenData.access_token, tokenData.user_id)
              .then((webhookResult) => {
                const jsonResponse = {
                  messageCF: "Token y webhook creados exitosamente",
                  respuesta: tokenData,
                  webhook: webhookResult,
                };
                res.status(statusCode).json(jsonResponse);
              })
              .catch((webhookError) => {
                console.error("Error al crear webhook:", webhookError);
                const jsonResponse = {
                  messageCF: "Token obtenido pero error al crear webhook",
                  respuesta: tokenData,
                  webhookError: webhookError.message,
                };
                res.status(statusCode).json(jsonResponse);
              });
        } else {
          const jsonResponse = {
            messageCF: "Error al ejecutar la Cloud Function",
            respuesta: responseData,
          };
          res.status(statusCode).json(jsonResponse);
        }
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

// Evaluar el nivel del cliente
/**
 * Evalúa el nivel del cliente basado en el total gastado
 * en los últimos 30 días.
 *
 * @param {FirebaseFirestore.DocumentReference} clienteRef
 * Referencia al documento del cliente en Firestore.
 * @param {FirebaseFirestore.DocumentReference} tiendaRef
 * Referencia al documento de la tienda en Firestore.
 */
async function evaluarNivel(clienteRef, tiendaRef) {
  const ahora = new Date();
  const desde = new Date();
  desde.setDate(ahora.getDate() - 30); // ventana de 30 días

  try {
    // Registrar inicio de la función
    await db.collection("logs_firebase_functions").doc().set({
      message: "Inicio de evaluarNivel",
      clienteRef: clienteRef.id,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 1. Traer órdenes en ese rango
    const ordenesSnap = await db.collection("ordenes")
        .where("cliente", "==", clienteRef)
        .where("fecha", ">=", desde)
        .get();

    let totalGastado = 0;
    ordenesSnap.forEach((doc) => {
      const total = Number(doc.data().total);
      totalGastado += !isNaN(total) ? total : 0;
    });

    // Registrar total gastado
    await db.collection("logs_firebase_functions").doc().set({
      message: "Total gastado calculado",
      totalGastado: totalGastado,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 2. Determinar nivel según totalGastado
    let nuevoNivel = "standard"; // Valor predeterminado
    let procentajeBeneficio = 0;

    const nivelesSnap = await db.collection("niveles")
        .where("Tienda", "==", tiendaRef)
        .orderBy("GastoMinimo", "desc") // Ordenar por monto de mayor a menor
        .get();

    const expiresAt = new Date();

    if (!nivelesSnap.empty) {
      for (const nivelDoc of nivelesSnap.docs) {
        const nivelData = nivelDoc.data();

        if (totalGastado >= nivelData.GastoMinimo) {
          await db.collection("logs_firebase_functions").doc().set({
            message: "Si detecta el Total gastado calculado",
            totalGastado: totalGastado,
            nivelDetectado: nivelDoc.id,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });
          nuevoNivel = nivelDoc.ref;
          procentajeBeneficio = nivelData.procentaje_beneficio;

          // Calcular la expiración del nivel
          const tipo = nivelData.vencimiento_tipo_frecuencia;
          const cantidad = nivelData.vencimiento_frecuencia;

          if (tipo === 1) {
            expiresAt.setMonth(expiresAt.getMonth() + cantidad);
          } else if (tipo === 2) {
            expiresAt.setFullYear(expiresAt.getFullYear() + cantidad);
          }

          break; // Salir del bucle una vez encontrado el nivel
        }
      }
    }

    // Registrar nivel determinado
    await db.collection("logs_firebase_functions").doc().set({
      message: "Nivel determinado",
      nuevoNivel: nuevoNivel,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Si no se cumple ninguna condición, eliminar el campo "nivel"
    if (nuevoNivel === "standard") {
      await clienteRef.update({
        nivel: admin.firestore.FieldValue.delete(),
        vencimiento_nivel: admin.firestore.FieldValue.delete(),
      });
    } else {
      const codigoCupon = await generarCuponUnico(); // Generar un código único

      await clienteRef.update({
        nivel: nuevoNivel,
        vencimiento_nivel: expiresAt,
        cupon_nivel: codigoCupon, // Usar el mismo código generado
      });

      // Generar un cupón de descuento en Tienda Nube
      try {
        const tiendaData = await tiendaRef.get();
        const tiendaUserId = tiendaData.data().user_id;

        const couponData = JSON.stringify({
          code: codigoCupon, // Usar el mismo código generado
          type: "percentage",
          value: procentajeBeneficio,
          start_date: new Date().toISOString().split("T")[0],
          end_date: expiresAt.toISOString().split("T")[0],
        });

        const options = {
          hostname: "api.tiendanube.com",
          path: `/v1/${tiendaUserId}/coupons`,
          method: "POST",
          headers: {
            "Authentication": `bearer ${tiendaData.data().token}`,
            "Content-Type": "application/json",
            "User-Agent": "SistemaNube/1.0",
            "Content-Length": couponData.length,
          },
        };

        const request = https.request(options, (response) => {
          let responseData = "";

          response.on("data", (chunk) => {
            responseData += chunk;
          });

          response.on("end", async () => {
            if (response.statusCode === 201) {
              await db.collection("logs_firebase_functions").doc().set({
                message: "Cupón generado exitosamente",
                clienteRef: clienteRef,
                cuponId: codigoCupon,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              console.error("Error al generar el cupón:", responseData);
              await db.collection("logs_firebase_functions").doc().set({
                message: "Error al generar el cupón:",
                responseData: responseData,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
        });

        request.on("error", (error) => {
          console.error("Error en la solicitud de cupón:", error.message);
        });

        request.write(couponData);
        request.end();
      } catch (error) {
        console.error("Error al generar el cupón:", error.message);
        await db.collection("logs_firebase_functions").doc().set({
          message: "Error al generar el cupón",
          error: error.message,
          stack: error.stack,
          clienteRef: clienteRef.id,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Registrar actualización del cliente
      await db.collection("logs_firebase_functions").doc().set({
        message: "Cliente actualizado con nuevo nivel",
        clienteRef: clienteRef.id,
        nivel: nuevoNivel.id,
        vencimiento_nivel: expiresAt,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (error) {
    // Registrar error
    await db.collection("logs_firebase_functions").doc().set({
      message: "Error en evaluarNivel",
      error: error.message,
      stack: error.stack,
      clienteRef: clienteRef.id,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.error("Error en evaluarNivel:", error);
  }
}

/**
 * Procesa un nuevo documento en la colección "orders".
 *
 * @param {functions.firestore.DocumentSnapshot} event
 * Evento que contiene los datos del documento creado.
 * @param {string} orderId ID de la orden.
 * @param {string} storeId ID de la tienda.
 */
async function procesarNuevoDocumentoEnOrders(event, orderId, storeId) {
  await db.collection("logs_firebase_functions")
      .doc().set({
        message: "Si entra en procesarNuevoDocumentoEnOrders",
        storeId: storeId,
      });

  // Buscar la tienda asociada al store_id
  const tiendaDoc = await db
      .collection("tiendas")
      .where("user_id", "==", storeId.toString())
      .limit(1)
      .get();

  if (tiendaDoc.empty) {
    await db.collection("logs_firebase_functions")
        .doc().set({message: "No se encontró la tienda asociada al store_id"});
    return;
  }

  const tiendaData = tiendaDoc.docs[0].data();
  const tiendaToken = tiendaData.token;

  const options = {
    hostname: "api.tiendanube.com",
    path: `/v1/${storeId}/orders/${orderId}`,
    method: "GET",
    headers: {
      "Authentication": `bearer ${tiendaToken}`,
      "User-Agent": "SistemaNube/1.0",
    },
  };

  const request = https.request(options, async (response) => {
    await db.collection("logs_firebase_functions")
        .doc().set({message: "Si ejecuta api.tiendanube.com"});

    let responseData = "";

    response.on("data", (chunk) => {
      responseData += chunk;
    });

    response.on("end", async () => {
      if (response.statusCode === 200) {
        const orderDetails = JSON.parse(responseData);

        await db.collection("logs_firebase_functions")
            .doc().set({message: "tienda responde 200"});

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
          canje: tiendaData.canje_puntos,
          equivalencia: tiendaData.equivalencia_puntos,
          motivoExterno: "Hiciste una compra",
          motivoInterno: "Hizo una compra",
          fecha: admin.firestore.FieldValue.serverTimestamp(),
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
          total: Number(orderDetails.total),
          customer_id: orderDetails.customer.id,
          tienda: tiendaDoc.docs[0].ref,
          cliente: clienteRef,
        });

        // Verificar uso de cupon
        if (
          Array.isArray(orderDetails.coupon) &&
          orderDetails.coupon.length > 0
        ) {
          await db.collection("logs_firebase_functions")
              .doc().set({message: "Si detecta el cupon"});

          const couponId = orderDetails.coupon[0].id;

          if (couponId) {
            await db.collection("logs_firebase_functions")
                .doc().set({
                  message: "si entra en couponId",
                  IDCuponTiendaNube: couponId});

            const cuponQuery = await db.collection("cupones")
                .where("IDCuponTiendaNube", "==", couponId.toString())
                .limit(1)
                .get();

            if (!cuponQuery.empty) {
              const cuponDocRef = cuponQuery.docs[0].ref;
              await cuponDocRef.update({
                estado: true,
              });

              await db.collection("logs_firebase_functions")
                  .doc().set({
                    message:
                        "Si tiene IDCuponTiendaNube y se actualizó el estado " +
                        "a true",
                  });
            }
          }
        } else {
          console.warn("No se detectó un cupón válido en la orden.");
        }

        await evaluarNivel(clienteRef, tiendaDoc.docs[0].ref);
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
}

exports.webhookOrderPaid = functions.https.onRequest((req, res) => {
  cors(corsOptions)(req, res, async () => {
    const orderData = req.body;

    try {
      // Obtener el token de la tienda desde Firestore
      const tiendaDoc = await db
          .collection("tiendas")
          .where("user_id", "==", orderData.store_id.toString())
          .limit(1)
          .get();

      if (tiendaDoc.empty) {
        await db.collection("logs_firebase_functions")
            .doc().set({message: "No se encontró la tienda"});

        return res.status(400).json({
          messageCF: "No se encontró la tienda asociada al store_id",
        });
      }

      const tiendaData = tiendaDoc.docs[0].data();
      const tiendaToken = tiendaData.token;

      // Consultar los detalles de la orden desde la API de Tienda Nube
      const options = {
        hostname: "api.tiendanube.com",
        path: `/v1/${orderData.store_id}/orders/${orderData.id}`,
        method: "GET",
        headers: {
          "Authentication": `bearer ${tiendaToken}`,
          "User-Agent": "SistemaNube/1.0",
        },
      };

      const orderDetails = await new Promise((resolve, reject) => {
        const request = https.request(options, async (response) => {
          let responseData = "";

          response.on("data", (chunk) => {
            responseData += chunk;
          });

          response.on("end", async () => {
            if (response.statusCode === 200) {
              resolve(JSON.parse(responseData));
            } else {
              await db.collection("logs_firebase_functions")
                  .doc().set({
                    message: "Error al obtener los detalles de la orden",
                  });

              reject(new Error(`Error al obtener los detalles de la orden: 
                ${responseData}`));
            }
          });
        });

        request.on("error", (error) => {
          reject(error);
        });

        request.end();
      });

      // Validar si el cliente ya está registrado en la colección "clientes"
      const clienteQuery = await db.collection("clientes")
          .where("LsCustomer", "==", orderDetails.customer.id)
          .limit(1)
          .get();

      if (clienteQuery.empty) {
        await db.collection("logs_firebase_functions")
            .doc().set({
              message: "El cliente no está registrado en el sistema",
            });

        return res.status(400).json({
          messageCF: "El cliente no está registrado en el sistema",
        });
      }

      // Verificar si la orden ya existe
      const ordersQuery = await db
          .collection("ordenes")
          .where("id", "==", orderData.id)
          .get();

      if (!ordersQuery.empty) {
        return res.status(400).json({
          messageCF: "La orden ya ha sido registrada previamente",
        });
      }

      // Agregar la nueva orden y obtener la referencia del documento
      const docRef = await db.collection("ordenes").add({
        ...orderData,
        fecha: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Obtener el documento recién creado
      const newOrderDoc = await docRef.get();

      // Simular el evento para procesar el nuevo documento
      const simulatedEvent = {
        data: newOrderDoc,
      };
      await procesarNuevoDocumentoEnOrders(simulatedEvent,
          orderData.id, orderData.store_id);

      // Respuesta exitosa
      res.status(200).json({
        messageCF: "Orden procesada y registrada exitosamente",
      });
    } catch (error) {
      // Manejo de errores
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

exports.calcularFaltanteNivel = functions.https.onRequest(async (req, res) => {
  cors(corsOptions)(req, res, async () => {
    const {clienteId, tiendaId} = req.body;

    if (!clienteId || !tiendaId) {
      return res.status(400).json({
        messageCF: "Los parámetros 'clienteId' y 'tiendaId' son obligatorios",
      });
    }

    try {
      const clienteRef = db.collection("clientes").doc(clienteId);
      const tiendaRef = db.collection("tiendas").doc(tiendaId);

      const ahora = new Date();
      const desde = new Date();
      desde.setDate(ahora.getDate() - 30); // Últimos 30 días

      // Obtener órdenes del cliente en los últimos 30 días
      const ordenesSnap = await db.collection("ordenes")
          .where("cliente", "==", clienteRef)
          .where("fecha", ">=", desde)
          .get();

      let totalGastado = 0;
      ordenesSnap.forEach((doc) => {
        const total = Number(doc.data().total);
        totalGastado += !isNaN(total) ? total : 0;
      });

      // Obtener niveles de la tienda
      const nivelesSnap = await db.collection("niveles")
          .where("Tienda", "==", tiendaRef)
          .orderBy("GastoMinimo", "asc") // Ordenar de menor a mayor
          .get();

      if (nivelesSnap.empty) {
        return res.status(404).json({
          messageCF: "No se encontraron niveles para la tienda especificada",
        });
      }

      let faltante = null;
      let siguienteNivel = null;
      for (const nivelDoc of nivelesSnap.docs) {
        const nivelData = nivelDoc.data();
        if (totalGastado < nivelData.GastoMinimo) {
          faltante = nivelData.GastoMinimo - totalGastado;
          siguienteNivel = nivelData.Titulo; // Obtener el nombre del nivel
          break;
        }
      }

      if (faltante === null) {
        return res.status(200).json({
          messageCF: "El cliente ya ha alcanzado el nivel más alto",
          faltante: 0,
          siguienteNivel: "Ninguno", // No hay nivel siguiente
        });
      }

      res.status(200).json({
        messageCF: "Cálculo realizado con éxito",
        totalGastado,
        faltante,
        siguienteNivel,
      });
    } catch (error) {
      await db.collection("logs_firebase_functions").doc().set({
        message: "Error en calcularFaltanteNivel",
        error: error.message,
        stack: error.stack,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(500).json({
        messageCF: "Error al calcular el faltante para el siguiente nivel",
        error: error.message,
      });
    }
  });
});

/**
 * Generates a random block of uppercase letters of a specified length.
 *
 * @param {number} [length=3] - The length of the random block.
 * @return {string} A string containing random uppercase letters.
 */
function randomBlock(length = 3) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generates a unique coupon code consisting of three random blocks
 * of uppercase letters.
 *
 * @return {string} A string in the format "XXX-XXX-XXX"
 * where X is a random uppercase letter.
 */
function generateCouponCode() {
  return `${randomBlock()}-${randomBlock()}-${randomBlock()}`;
}

/**
 * Genera un código de cupón único y lo guarda en Firestore.
 *
 * @return {Promise<string>} El código de cupón único generado.
 * @throws {Error} Si no se puede generar un cupón único
 * después de varios intentos.
 */
async function generarCuponUnico() {
  let codigoUnico = "";
  let intentos = 0;
  const maxIntentos = 10;

  while (intentos < maxIntentos) {
    const nuevoCodigo = generateCouponCode();
    const docRef = db.collection("codigo_cupones").doc(nuevoCodigo);
    const doc = await docRef.get();

    if (!doc.exists) {
      await docRef.set({
        fecha: admin.firestore.FieldValue.serverTimestamp(),
      });
      codigoUnico = nuevoCodigo;
      break;
    }

    intentos++;
  }

  if (!codigoUnico) {
    throw new Error("No se pudo generar un cupón único");
  }

  return codigoUnico;
}

/**
 * Crea un webhook en Tienda Nube para el evento order/paid
 * @param {string} accessToken - Token de acceso para la API de Tienda Nube
 * @param {string} userId - ID del usuario de la tienda
 * @return {Promise<Object>} Resultado de la creación del webhook
 */
async function crearWebhookTiendaNube(accessToken, userId) {
  return new Promise((resolve, reject) => {
    const webhookData = JSON.stringify({
      event: "order/paid",
      url: "https://webhookorderpaid-txl6s4cyeq-uc.a.run.app",
    });

    const options = {
      hostname: "api.tiendanube.com",
      path: `/v1/${userId}/webhooks`,
      method: "POST",
      headers: {
        "Authentication": `bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "SistemaNube/1.0",
        "Content-Length": webhookData.length,
      },
    };

    const request = https.request(options, (response) => {
      let responseData = "";

      response.on("data", (chunk) => {
        responseData += chunk;
      });

      response.on("end", () => {
        if (response.statusCode === 201) {
          resolve(JSON.parse(responseData));
        } else {
          reject(new Error(`Error al crear webhook: ${responseData}`));
        }
      });
    });

    request.on("error", (error) => {
      reject(error);
    });

    request.write(webhookData);
    request.end();
  });
}

exports.crearCuponTiendaNube = functions.https.onRequest((req, res) => {
  cors(corsOptions)(req, res, async () => {
    const {storeId, value, startDate, endDate} = req.body;

    // Validar parámetros obligatorios
    if (!storeId || !value || !startDate || !endDate) {
      return res.status(400).json({
        messageCF: "Los parámetros 'storeId', 'value', " +
          "'startDate' y 'endDate' son obligatorios",
      });
    }

    /**
     * Convierte una fecha del formato DD-M-YYYY a YYYY-MM-DD
     * @param {string} dateString - Fecha en formato DD-M-YYYY
     * @return {string} Fecha en formato YYYY-MM-DD
     */
    function formatDateForAPI(dateString) {
      const parts = dateString.split("-");
      if (parts.length !== 3) {
        throw new Error(`Formato de fecha inválido: ${dateString}`);
      }
      const day = parts[0].padStart(2, "0");
      const month = parts[1].padStart(2, "0");
      const year = parts[2];
      return `${year}-${month}-${day}`;
    }

    try {
      // Convertir fechas al formato correcto
      const formattedStartDate = formatDateForAPI(startDate);
      const formattedEndDate = formatDateForAPI(endDate);

      // Obtener el token de la tienda desde Firestore
      const tiendaDoc = await db
          .collection("tiendas")
          .where("user_id", "==", storeId.toString())
          .limit(1)
          .get();

      if (tiendaDoc.empty) {
        return res.status(404).json({
          messageCF: "No se encontró la tienda asociada al storeId",
        });
      }

      const tiendaData = tiendaDoc.docs[0].data();
      const token = tiendaData.token;

      // Generar código único de cupón
      const codigoCupon = await generarCuponUnico();

      // Datos del cupón para la API
      const couponData = JSON.stringify({
        code: codigoCupon,
        type: "absolute",
        value: value,
        max_uses: 1,
        start_date: formattedStartDate,
        end_date: formattedEndDate,
      });

      const options = {
        hostname: "api.tiendanube.com",
        path: `/v1/${storeId}/coupons`,
        method: "POST",
        headers: {
          "Authentication": `bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "SistemaNube/1.0",
          "Content-Length": couponData.length,
        },
      };

      // Realizar la petición HTTP
      const request = https.request(options, (response) => {
        let responseData = "";

        response.on("data", (chunk) => {
          responseData += chunk;
        });

        response.on("end", () => {
          if (response.statusCode === 201) {
            const cuponCreado = JSON.parse(responseData);
            res.status(201).json({
              messageCF: "Cupón creado exitosamente",
              cupon: cuponCreado,
              codigoGenerado: codigoCupon,
            });
          } else {
            console.error("Error al crear el cupón:", responseData);
            res.status(response.statusCode).json({
              messageCF: "Error al crear el cupón en Tienda Nube",
              error: responseData,
            });
          }
        });
      });

      request.on("error", (error) => {
        console.error("Error en la solicitud:", error);
        res.status(500).json({
          messageCF: "Error en la solicitud HTTP",
          error: error.message,
        });
      });

      request.write(couponData);
      request.end();
    } catch (error) {
      console.error("Error generando cupón:", error);
      // Si el error es de formato de fecha, devolver un mensaje más específico
      if (error.message.includes("Formato de fecha inválido")) {
        res.status(400).json({
          messageCF: "Error en el formato de fecha",
          error: error.message,
          formatoEsperado: "DD-M-YYYY (ejemplo: 18-7-2025)",
        });
      } else {
        res.status(500).json({
          messageCF: "Error del servidor",
          error: error.message,
        });
      }
    }
  });
});
