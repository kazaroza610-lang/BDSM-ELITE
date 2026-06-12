const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// INITIALISATION BASE DE DONNÉES
// ============================================

const dbPath = path.join(__dirname, 'shop.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ Erreur DB:', err);
  else console.log('✅ Base de données connectée');
});

// Créer les tables si elles n'existent pas
db.serialize(() => {
  // Table des produits
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table des commandes
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT,
      customer_address TEXT NOT NULL,
      customer_city TEXT NOT NULL,
      customer_postal_code TEXT NOT NULL,
      customer_country TEXT NOT NULL DEFAULT 'France',
      total_price REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table des articles de commande
  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);

  // Table des administrateurs
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅ Tables créées/vérifiées');
});

// ============================================
// UTILITAIRES
// ============================================

// Fonction pour exécuter une requête SELECT
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Fonction pour INSERT/UPDATE/DELETE
const dbExec = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

// ============================================
// AUTHENTIFICATION ADMIN
// ============================================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // À changer en production

const verifyAdminPassword = (password) => {
  return password === ADMIN_PASSWORD;
};

const adminMiddleware = (req, res, next) => {
  const password = req.headers['x-admin-password'];
  if (!password || !verifyAdminPassword(password)) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  next();
};

// ============================================
// API PRODUITS
// ============================================

// GET tous les produits (publique)
app.get('/api/products', async (req, res) => {
  try {
    const products = await dbRun('SELECT * FROM products ORDER BY created_at DESC');
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la récupération des produits' });
  }
});

// GET un produit par ID (publique)
app.get('/api/products/:id', async (req, res) => {
  try {
    const products = await dbRun('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (products.length === 0) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }
    res.json(products[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// POST ajouter un produit (admin)
app.post('/api/products', adminMiddleware, async (req, res) => {
  const { name, description, price, stock, image_url } = req.body;

  // Validation
  if (!name || !price || stock === undefined) {
    return res.status(400).json({ error: 'Données manquantes' });
  }

  if (price < 0 || stock < 0) {
    return res.status(400).json({ error: 'Le prix et stock doivent être positifs' });
  }

  try {
    const result = await dbExec(
      'INSERT INTO products (name, description, price, stock, image_url) VALUES (?, ?, ?, ?, ?)',
      [name, description || '', price, stock, image_url || '']
    );
    res.status(201).json({ id: result.id, message: 'Produit créé' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// PUT modifier un produit (admin)
app.put('/api/products/:id', adminMiddleware, async (req, res) => {
  const { name, description, price, stock, image_url } = req.body;

  if (!name || price === undefined || stock === undefined) {
    return res.status(400).json({ error: 'Données manquantes' });
  }

  try {
    await dbExec(
      'UPDATE products SET name = ?, description = ?, price = ?, stock = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, description || '', price, stock, image_url || '', req.params.id]
    );
    res.json({ message: 'Produit modifié' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la modification' });
  }
});

// DELETE supprimer un produit (admin)
app.delete('/api/products/:id', adminMiddleware, async (req, res) => {
  try {
    await dbExec('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ message: 'Produit supprimé' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// ============================================
// API COMMANDES
// ============================================

// POST créer une commande
app.post('/api/orders', async (req, res) => {
  const { customer_name, customer_email, customer_phone, customer_address, customer_city, customer_postal_code, customer_country, items } = req.body;

  // Validation
  if (!customer_name || !customer_email || !customer_address || !customer_city || !customer_postal_code || !items || items.length === 0) {
    return res.status(400).json({ error: 'Données de commande manquantes' });
  }

  try {
    // Calculer le prix total et vérifier le stock
    let totalPrice = 0;
    const productsInfo = [];

    for (const item of items) {
      const products = await dbRun('SELECT * FROM products WHERE id = ?', [item.product_id]);
      if (products.length === 0) {
        return res.status(404).json({ error: `Produit ${item.product_id} non trouvé` });
      }

      const product = products[0];
      if (product.stock < item.quantity) {
        return res.status(400).json({ error: `Stock insuffisant pour ${product.name}` });
      }

      totalPrice += product.price * item.quantity;
      productsInfo.push({ ...product, orderedQuantity: item.quantity });
    }

    // Créer la commande
    const orderResult = await dbExec(
      'INSERT INTO orders (customer_name, customer_email, customer_phone, customer_address, customer_city, customer_postal_code, customer_country, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [customer_name, customer_email, customer_phone || '', customer_address, customer_city, customer_postal_code, customer_country || 'France', totalPrice]
    );

    const orderId = orderResult.id;

    // Ajouter les articles et réduire le stock
    for (let i = 0; i < productsInfo.length; i++) {
      const product = productsInfo[i];
      
      // Ajouter à order_items
      await dbExec(
        'INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
        [orderId, product.id, product.name, product.orderedQuantity, product.price]
      );

      // Réduire le stock
      await dbExec(
        'UPDATE products SET stock = stock - ? WHERE id = ?',
        [product.orderedQuantity, product.id]
      );
    }

    res.status(201).json({ 
      order_id: orderId, 
      total_price: totalPrice,
      message: 'Commande créée avec succès' 
    });
  } catch (err) {
    console.error('Erreur commande:', err);
    res.status(500).json({ error: 'Erreur lors de la création de la commande' });
  }
});

// GET toutes les commandes (admin)
app.get('/api/orders', adminMiddleware, async (req, res) => {
  try {
    const orders = await dbRun('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// GET une commande avec ses articles (admin)
app.get('/api/orders/:id', adminMiddleware, async (req, res) => {
  try {
    const orders = await dbRun('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    const items = await dbRun('SELECT * FROM order_items WHERE order_id = ?', [req.params.id]);
    res.json({ ...orders[0], items });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// PUT mettre à jour le statut d'une commande (admin)
app.put('/api/orders/:id', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  try {
    await dbExec(
      'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, req.params.id]
    );
    res.json({ message: 'Commande mise à jour' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🚀 Serveur e-commerce démarré!       ║
║  http://localhost:${PORT}                   ║
║                                        ║
║  Admin: http://localhost:${PORT}/admin.html ║
║  Shop:  http://localhost:${PORT}/shop.html  ║
╚════════════════════════════════════════╝
  `);
});

// Gérer l'arrêt gracieux
process.on('SIGINT', () => {
  db.close(() => {
    console.log('✅ Base de données fermée');
    process.exit(0);
  });
});
