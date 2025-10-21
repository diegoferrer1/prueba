/* ===========================
    IMPORTACIONES DE FIREBASE
    =========================== */
import { 
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { 
    getFirestore,
    doc,
    setDoc,
    getDoc,
    collection,
    onSnapshot,
    query,
    addDoc,
    serverTimestamp,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { app } from './firebase-config.js'; // Solo importamos la app inicializada

// Estas variables y la función initMap están en el scope del módulo.
let mapApiLoaded = false;
const mapApiLoadCallbacks = [];

function initMap() {
    console.log("Google Maps API loaded and initMap called.");
    mapApiLoaded = true;
    mapApiLoadCallbacks.forEach(callback => callback());
}
// Exponemos la función al scope global para que el script de Google Maps pueda encontrarla.
window.initMap = initMap;

document.addEventListener('DOMContentLoaded', () => {

    /* ===========================
        Selectores y Variables Globales
        =========================== */
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => document.querySelectorAll(selector);

    // Instancias de Firebase
    const auth = getAuth(app);
    const db = getFirestore(app);

    // Modales y Drawers
    const $authModal = $('#authModal');
    const $cartDrawer = $('#cartDrawer');
    const $quantityModal = $('#quantityModal');
    const $commentModal = $('#commentModal');
    const $optionsModal = $('#optionsModal');
    const $confirmationModal = $('#confirmationModal');
    const $mapModal = $('#mapModal');
    const $locationSelectionDrawer = $('#locationSelectionDrawer'); 
    
    // Contenido y UI principal
    const $contentSection = $('#content');
    const $chipsContainer = $('#chips');

    // Referencias a colecciones de Firestore
    const categoriesCol = collection(db, 'categories');
    const menuItemsCol = collection(db, 'menuItems');

    // Variables de estado
    let currentItemWithOptions = null;
    let map, geocoder, marker;
    let locationTarget = null; // 'cart' o 'register'

    const GOOGLE_MAPS_API_KEY = "AIzaSyDUNTpFKdTVDC2N-G1tqP377kWr2iddpA4";
    const PHONE_NUMBER = "18495142209"; 
    const ITBIS_RATE = 0.18;
    
    // Estado global de la aplicación
    const state = { 
        q: "", 
        cat: "Todo", 
        cart: [], 
        location: { address: null, coords: null },
        comment: "", 
        userProfile: null,
        categories: [], 
        menuItems: [],
        cartDiscount: 0,
        couponCode: null
    };

    /* ===========================
        Funciones Utilitarias
        =========================== */
    const toggleModal = (modal, open) => {
        if (modal) {
            modal.classList.toggle("is-open", open);
            if (open) {
                document.body.style.overflow = "hidden";
            } else {
                const anyModalOpen = $$('.scrim.is-open').length > 0;
                if (!anyModalOpen) {
                    document.body.style.overflow = "";
                }
            }
        }
    };

    function showNotification(message, isError = false) {
        const existingNotif = document.querySelector('.notification');
        if (existingNotif) existingNotif.remove();
        const notification = document.createElement('div');
        notification.className = `notification ${isError ? 'is-error' : ''}`;
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => { notification.remove(); }, 3000);
    }

    const fmt = (n) => `RD$${Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const parseOption = (optionText) => {
        const match = optionText.match(/\(\s*\+RD\$([\d.,]+)\s*\)/);
        if (match) {
            const price = parseFloat(match[1].replace(/,/g, ''));
            const name = optionText.replace(match[0], '').trim();
            return { name, price };
        }
        return { name: optionText.trim(), price: 0 };
    };

    /* ===========================
        Lógica del Carrito y Cupones
        =========================== */
    const addToCart = (item, options = {}) => {
        const { qty = 1, selectedOptions = [], itemComment = '' } = options;
        const selectedOptionsNames = selectedOptions.map(opt => opt.name).sort().join(',');
        const itemIdentifier = `${item.id}-${selectedOptionsNames}-${itemComment || 'no-comment'}`;

        const existingItem = state.cart.find(cartItem => cartItem.identifier === itemIdentifier);
        
        if (existingItem) {
            existingItem.qty += qty;
        } else {
            state.cart.push({ 
                ...item, 
                qty, 
                selectedOptions,
                itemComment, 
                id: item.id,
                identifier: itemIdentifier
            });
        }
        renderCart();
        showNotification(`${qty}x ${item.name} añadido al carrito.`);
    };

    const updateCartItemQty = (index, amount) => {
        if (!state.cart[index]) return;
        state.cart[index].qty += amount;
        if (state.cart[index].qty <= 0) state.cart.splice(index, 1);
        renderCart();
    };

    const clearCart = () => { 
        state.cart = []; 
        state.comment = "";
        state.cartDiscount = 0;
        state.couponCode = null;
        $('#coupon-code-input').value = '';
        renderCart(); 
        renderCommentStatus();
    };

    const cartSubtotal = () => state.cart.reduce((total, item) => {
        const optionsTotal = item.selectedOptions.reduce((sum, opt) => sum + opt.price, 0);
        return total + ((item.price + optionsTotal) * item.qty);
    }, 0);

    const setCouponStatus = (message, type) => {
        const el = $('#coupon-status');
        if(el) {
            el.textContent = message;
            el.className = `coupon-status-text ${type}`;
        }
    };
    
    const applyCoupon = async (codigo) => {
        if (!state.userProfile) {
            setCouponStatus('Debes iniciar sesión primero.', 'error');
            return;
        }
        if (!codigo) {
            setCouponStatus('Por favor, ingresa un código.', 'error');
            return;
        }

        const currentSubtotal = cartSubtotal();

        try {
            const result = await runTransaction(db, async (transaction) => {
                const couponRef = doc(db, "cupones_maestros", codigo);
                const userRef = doc(db, "usuarios", state.userProfile.uid);

                const couponDoc = await transaction.get(couponRef);
                const userDoc = await transaction.get(userRef);

                if (!couponDoc.exists() || !couponDoc.data().activo) {
                    throw new Error("El cupón no es válido o ha expirado.");
                }

                const couponData = couponDoc.data();
                if (currentSubtotal < couponData.minimo_compra) {
                    throw new Error(`Compra mínima de ${fmt(couponData.minimo_compra)} requerida.`);
                }
                
                if (couponData.usos_actuales >= couponData.limite_usos) {
                    throw new Error("Este cupón ha alcanzado su límite de usos.");
                }
                
                const userCoupons = userDoc.exists() ? userDoc.data().cupones_usados || {} : {};
                if (userCoupons[codigo]) {
                    throw new Error("Ya has utilizado este cupón anteriormente.");
                }

                transaction.update(couponRef, { usos_actuales: couponData.usos_actuales + 1 });
                transaction.set(userRef, { cupones_usados: { ...userCoupons, [codigo]: true } }, { merge: true });
                
                const discount = currentSubtotal * couponData.porcentaje_descuento;
                return { discount, code: codigo };
            });
            
            state.cartDiscount = result.discount;
            state.couponCode = result.code;
            renderCart(); // Recalcular todo con el descuento
            setCouponStatus(`¡Cupón '${state.couponCode}' aplicado!`, 'success');

        } catch (error) {
            state.cartDiscount = 0;
            state.couponCode = null;
            renderCart(); // Recalcular todo sin el descuento
            setCouponStatus(error.message, 'error');
            console.error("Error al aplicar cupón:", error);
        }
    };


    /* ===========================
        Lógica del Mapa
        =========================== */
    
    function onMapApiReady(callback) {
        if (mapApiLoaded) {
            callback();
        } else {
            mapApiLoadCallbacks.push(callback);
        }
    }

    async function initializeMap() {
        if (!map) {
            const santiago = { lat: 19.4517, lng: -70.6970 };
            const { Map } = await google.maps.importLibrary("maps");
            const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

            map = new Map($('#map'), {
                center: santiago,
                zoom: 15,
                disableDefaultUI: true,
                zoomControl: true,
                mapId: 'PALAU_DELIVERY_MAP' // Se recomienda un ID de mapa
            });
            
            geocoder = new google.maps.Geocoder();
            
            marker = new AdvancedMarkerElement({
                map: map,
                position: santiago,
                gmpDraggable: true,
            });

            map.addListener("center_changed", () => {
                if (marker) {
                    marker.position = map.getCenter();
                }
            });

            map.addListener("dragend", () => {
                geocodeLatLng(map.getCenter());
            });
        }
    }
    
    function geocodeLatLng(latlng) {
        const confirmBtn = $('#confirmLocationBtn');
        geocoder.geocode({ location: latlng }, (results, status) => {
            if (status === "OK" && results[0]) {
                const address = results[0].formatted_address;
                $('#mapAddress').textContent = address;
                const lat = typeof latlng.lat === 'function' ? latlng.lat() : latlng.lat;
                const lng = typeof latlng.lng === 'function' ? latlng.lng() : latlng.lng;
                state.location = { address, coords: { lat, lng } };
                if(confirmBtn) confirmBtn.disabled = false;
            } else {
                $('#mapAddress').textContent = "No se pudo determinar la dirección.";
                 const lat = typeof latlng.lat === 'function' ? latlng.lat() : latlng.lat;
                const lng = typeof latlng.lng === 'function' ? latlng.lng() : latlng.lng;
                state.location = { address: null, coords: { lat, lng } };
                if(confirmBtn) confirmBtn.disabled = true;
            }
        });
    }

    function findAndShowLocation() {
        initializeMap();
        
        $('.map-loader').classList.add('is-loading');

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const pos = {
                        lat: position.coords.latitude,
                        lng: position.coords.longitude,
                    };
                    map.setCenter(pos);
                    if (marker) {
                       marker.position = pos;
                    }
                    geocodeLatLng(pos);
                    $('.map-loader').classList.remove('is-loading');
                },
                (error) => {
                    let message = "Error: El servicio de geolocalización falló.";
                    if (error.code === error.PERMISSION_DENIED) {
                        message = "Permiso de ubicación denegado. Actívalo en los ajustes de tu navegador.";
                    }
                    showNotification(message, true);
                    $('.map-loader').classList.remove('is-loading');
                }
            );
        } else {
            showNotification("Error: Tu navegador no soporta geolocalización.", true);
            $('.map-loader').classList.remove('is-loading');
        }
    }
    
    function handleLocationRequest(target) {
        locationTarget = target;
        toggleModal($mapModal, true);
        $('.map-loader').classList.add('is-loading');
        onMapApiReady(findAndShowLocation);
    }


    /* ===========================
        Funciones de Renderizado
        =========================== */
    const renderList = () => {
        const { categories, menuItems } = state;

        let filteredItems = menuItems.filter(item => 
            item.visible === true && 
            (state.q === "" || item.name.toLowerCase().includes(state.q))
        );

        if (state.cat !== "Todo" && state.cat !== "") {
            const selectedCategory = categories.find(c => c.name === state.cat);
            if (selectedCategory) {
                 filteredItems = filteredItems.filter(item => item.categoryId === selectedCategory.id);
            }
        }
        
        $contentSection.innerHTML = '';
        const hasItems = filteredItems.length > 0;
        
        if (!hasItems) {
            const message = state.q !== "" ? `No hay resultados para "${state.q}".` : "No hay platillos visibles en este momento.";
            $contentSection.innerHTML = `<p style="text-align: center; color: var(--md-sys-color-on-surface-variant); padding: 2rem 0;">${message}</p>`;
            return;
        }

        categories.forEach(cat => {
            const itemsInCategory = filteredItems.filter(item => item.categoryId === cat.id);
            
            if (itemsInCategory.length > 0) {
                const section = document.createElement('section');
                section.className = 'section';
                section.id = cat.name.replace(/\s/g, '_');
                section.innerHTML = `
                    <h2 class="section__title">${cat.name}</h2>
                    <div class="grid">${itemsInCategory.map(it => {
                        const itemData = {
                            id: it.id,
                            name: it.name,
                            description: it.description,
                            price: it.price,
                            options: it.options || []
                        };
                        return `
                        <article class="m3-card">
                            <div class="m3-card__details">
                                <div class="title">${it.name}</div>
                                <p class="text-xs text-[var(--md-sys-color-on-surface-variant)] line-clamp-2">${it.description || ''}</p>
                                <div class="price">${it.price > 0 ? fmt(it.price) : 'Gratis'}</div>
                            </div>
                            <button class="btn-plus" data-add='${encodeURIComponent(JSON.stringify(itemData))}' aria-label="Agregar ${it.name}">+</button>
                        </article>
                        `;
                    }).join("")}</div>
                `;
                $contentSection.appendChild(section);
            }
        });
        
        $$('.m3-card').forEach((card, index) => card.style.animationDelay = `${index * 50}ms`);
    };

    const renderChips = () => {
        const categoryNames = state.categories.map(c => c.name);
        $chipsContainer.innerHTML = ["Todo", ...categoryNames].map(c => 
            `<button class="m3-chip ${c === state.cat ? 'is-active' : ''}" data-cat="${c}">${c}</button>`
        ).join('');
    }

    const renderCommentStatus = () => {
        $('#commentStatus').textContent = state.comment ? `"${state.comment}"` : 'Sin comentarios.';
    };

    const renderCart = () => {
        const subtotal = cartSubtotal();
        const subtotalWithDiscount = subtotal - state.cartDiscount;
        const itbis = subtotalWithDiscount * ITBIS_RATE;
        const total = subtotalWithDiscount + itbis;
        const totalItems = state.cart.reduce((sum, item) => sum + item.qty, 0);

        $('#fabBadge').textContent = String(totalItems);
        $('#fabCart').style.display = totalItems > 0 ? 'grid' : 'none';
        $('#cartSubtotal').textContent = fmt(subtotal);
        $('#cartItbis').textContent = fmt(itbis);
        $('#cartTotal').textContent = fmt(total);

        // Render discount row
        const $discountRow = $('#discount-row');
        if (state.cartDiscount > 0) {
            $('#cartDiscount').textContent = `-${fmt(state.cartDiscount)}`;
            $discountRow.style.display = 'flex';
        } else {
            $discountRow.style.display = 'none';
        }

        $('#waDrawer').disabled = totalItems === 0 || !state.location || !state.location.address || state.location.address.trim() === '';
        
        $('#drawerList').innerHTML = state.cart.length === 0 ? '<p style="text-align: center; color: var(--md-sys-color-on-surface-variant); padding: 2rem 0;">Tu carrito está vacío.</p>' :
            state.cart.map((it, index) => {
                const optionsTotal = it.selectedOptions.reduce((sum, opt) => sum + opt.price, 0);
                const itemTotal = (it.price + optionsTotal) * it.qty;
                const optionsText = it.selectedOptions.map(opt => `${opt.name}${opt.price > 0 ? ` (+${fmt(opt.price)})` : ''}`).join(', ');
                const fullDetails = [optionsText, it.itemComment].filter(Boolean).join(' • ');

                return `
                <div class="cart-item">
                    <div class="cart-item__details">
                        <div class="name">${it.name}</div>
                        ${fullDetails ? `<div class="options" style="font-size: 0.8rem; color: #777;">${fullDetails}</div>` : ''}
                        <div class="price" style="font-weight: 500; font-size: 0.9rem;">${fmt(itemTotal)}</div>
                    </div>
                    <div class="qty">
                        <button type="button" data-dec="${index}">−</button>
                        <span>${it.qty}</span>
                        <button type="button" data-inc="${index}">+</button>
                    </div>
                </div>`;
            }).join("");
    };

    /* ===========================
        Listeners de Firestore
        =========================== */
    function setupFirestoreListeners() {
        onSnapshot(query(categoriesCol), (snapshot) => {
            state.categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            state.categories.sort((a, b) => a.order - b.order);
            renderChips();
            renderList();
        }, (error) => {
            console.error("Error al obtener categorías:", error);
            showNotification("Error de conexión con la base de datos.", true);
        });

        onSnapshot(query(menuItemsCol), (snapshot) => {
            state.menuItems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            renderList();
        }, (error) => {
            console.error("Error al obtener ítems del menú:", error);
            showNotification("Error al cargar los platillos.", true);
        });
    }

    /* ===========================
        Lógica de Modales
        =========================== */
    
    const openOptionsModal = (item) => {
        if (!item.options || item.options.length === 0) {
            openQuantityModal(item);
            return;
        }

        currentItemWithOptions = item;
        $('#optionsProductName').textContent = item.name;
        
        const optionsContainer = $('#itemOptionsContainer');
        optionsContainer.innerHTML = '';
        item.options.forEach(optString => {
            const option = parseOption(optString);
            const chip = document.createElement('button');
            chip.className = 'option-chip';
            chip.textContent = `${option.name}${option.price > 0 ? ` (+${fmt(option.price)})` : ''}`;
            chip.dataset.name = option.name;
            chip.dataset.price = option.price;
            optionsContainer.appendChild(chip);
        });
        
        $('#itemOptionsSection').style.display = item.options.length > 0 ? 'block' : 'none';
        $('#optionsValue').textContent = '1';
        $('#itemCommentTextarea').value = '';
        toggleModal($optionsModal, true);
    };
    
    const openQuantityModal = (item) => {
        currentItemWithOptions = item;
        $('#quantityProductName').textContent = item.name;
        $('#quantityValue').textContent = '1';
        toggleModal($quantityModal, true);
    };

    const buildWhatsAppMessage = () => {
        const lines = ["*Pedido — Palau*"];
        state.cart.forEach(it => {
            const optionsTotal = it.selectedOptions.reduce((sum, opt) => sum + opt.price, 0);
            let itemLine = `• ${it.qty}x - ${it.name} (${fmt(it.price + optionsTotal)} c/u)`;
            lines.push(itemLine);
            
            if(it.selectedOptions.length > 0) {
                 it.selectedOptions.forEach(opt => {
                     lines.push(`  - ${opt.name}${opt.price > 0 ? ` (+${fmt(opt.price)})` : ''}`);
                 });
            }
            if(it.itemComment) lines.push(`  - Nota: ${it.itemComment}`);
        });
        const subtotal = cartSubtotal();
        const subtotalWithDiscount = subtotal - state.cartDiscount;
        lines.push(`\n--------------------`, `Subtotal: ${fmt(subtotal)}`);
        if (state.cartDiscount > 0) {
            lines.push(`Descuento (${state.couponCode}): -${fmt(state.cartDiscount)}`);
        }
        lines.push(`ITBIS (18%): ${fmt(subtotalWithDiscount * ITBIS_RATE)}`, `*Total: ${fmt(subtotalWithDiscount * (1 + ITBIS_RATE))}*`);
        
        if (state.location && state.location.address) {
            lines.push(`\n*Dirección:*`, state.location.address);
            if (state.location.coords) {
                const { lat, lng } = state.location.coords;
                lines.push(`(https://maps.google.com/?q=${lat},${lng})`);
            }
        } else {
            lines.push(`\n*El cliente no especificó una ubicación.*`);
        }
        
        if (state.comment) lines.push(`\n*Comentario General:* ${state.comment}`);
        lines.push("\n\nPor favor, confírmeme su nombre para completar el pedido.");
        
        return encodeURIComponent(lines.join("\n"));
    };

    /* ===========================
        Lógica de Autenticación
        =========================== */
    const authViews = { login: $('#view-login'), register: $('#view-register'), profile: $('#view-profile') };
    const showAuthView = (viewName) => {
        Object.values(authViews).forEach(view => { if(view) view.style.display = 'none' });
        if (authViews[viewName]) {
            authViews[viewName].style.display = 'block';
        }
    };

    async function handleRegister(e) {
        e.preventDefault();
        const email = $('#register-email').value;
        const password = $('#register-password').value;
        const direccion = $('#register-address').value;
        if (!direccion) {
            showNotification("Por favor, introduce una dirección.", true);
            return;
        }
        try {
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            await setDoc(doc(db, "usuarios", userCredential.user.uid), { 
                uid: userCredential.user.uid,
                email, 
                direccion,
                cupones_usados: {}
            });
            showNotification("¡Cuenta creada con éxito!");
            toggleModal($authModal, false);
        } catch (error) { showNotification("Error al registrar: " + error.message, true); }
    }

    function handleLogin(e) {
        e.preventDefault();
        const email = $('#login-email').value;
        const password = $('#login-password').value;
        signInWithEmailAndPassword(auth, email, password)
            .then(() => { 
                showNotification("¡Bienvenido de nuevo!"); 
                toggleModal($authModal, false); 
            })
            .catch((error) => showNotification("Error al iniciar sesión: " + error.message, true));
    }

    function handleLogout() {
        signOut(auth).then(() => { 
            showNotification("Has cerrado sesión."); 
            toggleModal($authModal, false); 
        });
    }

    /* ===========================
        Event Listener Principal (Delegación)
        =========================== */
    function setupEventListeners() {
        document.body.addEventListener('click', (e) => {
            const target = e.target;
            const addBtn = target.closest('[data-add]');
            if (addBtn) {
                const item = JSON.parse(decodeURIComponent(addBtn.dataset.add));
                openOptionsModal(item);
                return;
            }

            const chip = target.closest('[data-cat]');
            if (chip) {
                state.cat = chip.dataset.cat;
                $('.m3-chip.is-active')?.classList.remove('is-active');
                chip.classList.add('is-active');
                chip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                renderList();
                return;
            }

            const incBtn = target.closest('[data-inc]');
            if (incBtn) {
                updateCartItemQty(incBtn.dataset.inc, 1);
                return;
            }

            const decBtn = target.closest('[data-dec]');
            if (decBtn) {
                updateCartItemQty(decBtn.dataset.dec, -1);
                return;
            }
            
            // Lógica para botones principales por ID
            const actionMap = {
                'clearCartBtn': clearCart,
                'fabCart': () => toggleModal($cartDrawer, true),
                'drawerClose': () => toggleModal($cartDrawer, false),
                'waDrawer': () => {
                    const address = state.location.address;
                    if (state.cart.length > 0 && address && address.trim()) {
                        const salesCol = collection(db, 'sales');
                        addDoc(salesCol, {
                            timestamp: serverTimestamp(),
                            total: (cartSubtotal() - state.cartDiscount) * (1 + ITBIS_RATE),
                            items: state.cart.map(item => ({
                                name: item.name,
                                qty: item.qty,
                                price: item.price,
                                options: item.selectedOptions.map(opt => opt.name).join(', '),
                                itemComment: item.itemComment
                            })),
                            user: state.userProfile ? state.userProfile.uid : 'anonymous'
                        }).catch(err => console.error("Error al registrar la venta: ", err));
                        
                        $('#static-map').src = `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(address)}&zoom=16&size=600x300&markers=color:red%7C${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
                        $('#map-address-text').textContent = address;
                        
                        toggleModal($cartDrawer, false);
                        toggleModal($confirmationModal, true);
                        
                        window.open(`https://wa.me/${PHONE_NUMBER}?text=${buildWhatsAppMessage()}`, "_blank");
                    } else if (state.cart.length === 0) {
                        showNotification("El carrito está vacío.", true);
                    } else {
                        showNotification("Por favor, introduce una dirección para el delivery.", true);
                    }
                },
                'openCommentBtn': () => {
                    $('#commentTextarea').value = state.comment;
                    toggleModal($commentModal, true);
                },
                'confirmCommentBtn': () => {
                    state.comment = $('#commentTextarea').value.trim();
                    renderCommentStatus();
                    toggleModal($commentModal, false);
                },
                'confirmAddToCartBtn': (e) => {
                    const btn = e.target;
                    if (!btn.disabled && currentItemWithOptions) {
                        btn.disabled = true;
                        btn.textContent = 'Añadiendo...';
                        addToCart(currentItemWithOptions, { qty: parseInt($('#quantityValue').textContent) });
                        setTimeout(() => {
                            toggleModal($quantityModal, false);
                            btn.disabled = false;
                            btn.textContent = 'Añadir al Carrito';
                            currentItemWithOptions = null;
                        }, 300);
                    }
                },
                'quantityIncrement': () => $('#quantityValue').textContent++,
                'quantityDecrement': () => { if ($('#quantityValue').textContent > 1) $('#quantityValue').textContent--; },
                'confirmWithOptionsBtn': (e) => {
                    const btn = e.target;
                    if (!btn.disabled && currentItemWithOptions) {
                        btn.disabled = true;
                        btn.textContent = 'Añadiendo...';
                        const selectedOptions = Array.from($$('#itemOptionsContainer .is-selected')).map(chip => ({ name: chip.dataset.name, price: parseFloat(chip.dataset.price) }));
                        const options = { qty: parseInt($('#optionsValue').textContent), selectedOptions, itemComment: $('#itemCommentTextarea').value.trim() };
                        addToCart(currentItemWithOptions, options);
                        setTimeout(() => {
                            toggleModal($optionsModal, false);
                            btn.disabled = false;
                            btn.textContent = 'Confirmar y Añadir';
                            currentItemWithOptions = null;
                        }, 300);
                    }
                },
                'optionsIncrement': () => $('#optionsValue').textContent++,
                'optionsDecrement': () => { if ($('#optionsValue').textContent > 1) $('#optionsValue').textContent--; },
                'closeQuantityBtn': () => toggleModal($quantityModal, false),
                'closeOptionsBtn': () => toggleModal($optionsModal, false),
                'closeCommentBtn': () => toggleModal($commentModal, false),
                'profileBtn': () => {
                    toggleModal($authModal, true);
                    if (auth.currentUser) showAuthView('profile');
                    else showAuthView('login');
                },
                'goToRegister': (event) => { event.preventDefault(); showAuthView('register'); },
                'goToLogin': (event) => { event.preventDefault(); showAuthView('login'); },
                'logoutBtn': handleLogout,
                'openLocationSelectionBtn': () => {
                    const currentStatus = $('#locationStatus').textContent;
                    const manualInput = $('#locationSelectionDrawer #manualAddressInput');
                    if (currentStatus && !currentStatus.includes('Elige una ubicación')) {
                        manualInput.value = currentStatus;
                    } else {
                        manualInput.value = '';
                    }
                    if (state.userProfile && state.userProfile.direccion) {
                        $('#useSavedAddressBtn').style.display = 'flex';
                    } else {
                        $('#useSavedAddressBtn').style.display = 'none';
                    }
                    toggleModal($locationSelectionDrawer, true);
                },
                'closeLocationSelectionBtn': () => toggleModal($locationSelectionDrawer, false),
                'useSavedAddressBtn': () => {
                    if (state.userProfile && state.userProfile.direccion) {
                        state.location = { address: state.userProfile.direccion, coords: null };
                        $('#locationStatus').textContent = state.location.address;
                        renderCart();
                        showNotification("Dirección guardada utilizada.");
                        toggleModal($locationSelectionDrawer, false);
                    }
                },
                'openMapBtn': () => {
                    toggleModal($locationSelectionDrawer, false);
                    handleLocationRequest('cart');
                },
                'confirmManualAddressBtn': () => {
                    const address = $('#locationSelectionDrawer #manualAddressInput').value.trim();
                    if(address) {
                        state.location = { address: address, coords: null };
                        $('#locationStatus').textContent = address;
                        renderCart();
                        toggleModal($locationSelectionDrawer, false);
                    } else {
                        showNotification("Por favor, escribe una dirección.", true);
                    }
                },
                'openMapForRegisterBtn': () => {
                    toggleModal($authModal, false);
                    handleLocationRequest('register');
                },
                'closeMapBtn': () => {
                    toggleModal($mapModal, false);
                    if (locationTarget === 'register') toggleModal($authModal, true);
                },
                'confirmLocationBtn': () => {
                    if (state.location && state.location.address) {
                        if (locationTarget === 'cart') {
                            $('#locationStatus').textContent = state.location.address;
                            renderCart();
                        } else if (locationTarget === 'register') {
                            $('#register-address').value = state.location.address;
                            toggleModal($authModal, true);
                        }
                        toggleModal($mapModal, false);
                    }
                },
                'closeConfirmationBtn': () => {
                    toggleModal($confirmationModal, false);
                    clearCart();
                },
                'apply-coupon-btn': () => {
                    const code = $('#coupon-code-input').value.trim().toUpperCase();
                    applyCoupon(code);
                }
            };

            const targetId = target.closest('[id]');
            if (targetId && actionMap[targetId.id]) {
                actionMap[targetId.id](e);
                return;
            }
            
            if (target.closest('.auth-dialog .m3-icon-button[aria-label="Cerrar"]')) {
                 toggleModal($authModal, false);
            }

            if (target.classList.contains('option-chip')) {
                 target.classList.toggle('is-selected');
            }
        });

        $('#q').addEventListener("input", () => { 
            state.q = $('#q').value.trim().toLowerCase(); 
            renderList(); 
        });
        
        $('#login-form').addEventListener('submit', handleLogin);
        $('#register-form').addEventListener('submit', handleRegister);
        document.addEventListener("keydown", e => {
            if (e.key === "Escape") $$('.scrim.is-open').forEach(modal => toggleModal(modal, false));
        });
    }

    /* ===========================
        INICIALIZACIÓN DE LA APP
        =========================== */
    function main() {
        setupFirestoreListeners();
        setupEventListeners();
        renderCart();
        renderCommentStatus();
    }

    onAuthStateChanged(auth, async (user) => {
        const profileBtnLabel = $('#profileBtn-label');
        const applyCouponBtn = $('#apply-coupon-btn');
        let userProfile = null;

        if (user && !user.isAnonymous) {
            const userDoc = await getDoc(doc(db, "usuarios", user.uid));
            userProfile = userDoc.exists() ? { uid: user.uid, ...userDoc.data() } : { uid: user.uid, email: user.email };
            
            profileBtnLabel.textContent = userProfile.email ? userProfile.email.split('@')[0] : 'Perfil';
            $('#profile-email').textContent = userProfile.email || 'Email no disponible';
            $('#profile-address').textContent = userProfile.direccion || 'No has guardado una dirección.';
            
            if (applyCouponBtn) applyCouponBtn.disabled = false;
            setCouponStatus('Ingresa un cupón y aplícalo.', 'info');
            
        } else {
            profileBtnLabel.textContent = 'Iniciar Sesión';
            if($('#profile-email')) $('#profile-email').textContent = '';
            if($('#profile-address')) $('#profile-address').textContent = '';
            if (applyCouponBtn) applyCouponBtn.disabled = true;
            setCouponStatus('Inicia sesión para usar cupones.', 'info');
        }
        
        state.userProfile = userProfile;
        
        if (!state.location.address && userProfile && userProfile.direccion) {
            state.location = { address: userProfile.direccion, coords: null };
            $('#locationStatus').textContent = state.location.address;
            renderCart();
        }
    });

    main();
});
