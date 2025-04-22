exports.detectarNuevoDocumentoEnOrders = functions.firestore
    .document("orders/{orderId}")
    .onCreate(async (snap, context) => {
      try {
        // Obtén los datos del documento recién creado
        snap.data();

        // Agrega el campo "test:detectado" al documento
        await snap.ref.update({
          "test:detectado": true,
        });

        console.log(`Campo "test:detectado" agregado al documento con ID: 
          ${context.params.orderId}`);
      } catch (error) {
        console.error("Error al agregar el campo 'test:detectado':", error);
      }
    });