// Importa las funciones que necesitas de los SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// Tu configuración de Firebase que obtuviste de la consola
const firebaseConfig = {
  apiKey: "AIzaSyCRfM3a9fA1kmMDcjC0PvT686vw2ZutrTo",
  authDomain: "squaso.firebaseapp.com",
  projectId: "squaso",
  storageBucket: "squaso.appspot.com",
  messagingSenderId: "295008368495",
  appId: "1:295008368495:web:dca64ef037b9e536675a9a",
  measurementId: "G-XVGDJJPTSS"
};

// Inicializa Firebase
const app = initializeApp(firebaseConfig);

// Exporta solo la instancia de la app. Los otros módulos importarán lo que necesiten.
export { app };