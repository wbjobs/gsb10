/* db.js - IndexedDB persistence layer (shared by main thread and worker)
 * songs store: { id, name, duration, hashCount, createdAt, peaks }
 * fps store:   { songId, hashes, times }
 */
(function (global) {
  'use strict';
  var DB_NAME = 'audio-fingerprint-db';
  var DB_VERSION = 1;
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('songs')) {
          db.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('fps')) {
          db.createObjectStore('fps', { keyPath: 'songId' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(db, stores, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(stores, mode);
      var result;
      t.oncomplete = function () { resolve(result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
      result = fn(t);
    });
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var api = {
    addSong: function (meta) {
      return openDb().then(function (db) {
        return tx(db, ['songs'], 'readwrite', function (t) {
          return reqToPromise(t.objectStore('songs').add(meta));
        });
      });
    },
    putFp: function (songId, hashes, times) {
      return openDb().then(function (db) {
        return tx(db, ['fps'], 'readwrite', function (t) {
          t.objectStore('fps').put({ songId: songId, hashes: hashes, times: times });
        });
      });
    },
    getAllSongs: function () {
      return openDb().then(function (db) {
        return reqToPromise(db.transaction(['songs']).objectStore('songs').getAll());
      });
    },
    getAllFps: function () {
      return openDb().then(function (db) {
        return reqToPromise(db.transaction(['fps']).objectStore('fps').getAll());
      });
    },
    getSong: function (id) {
      return openDb().then(function (db) {
        return reqToPromise(db.transaction(['songs']).objectStore('songs').get(id));
      });
    },
    deleteSong: function (id) {
      return openDb().then(function (db) {
        return tx(db, ['songs', 'fps'], 'readwrite', function (t) {
          t.objectStore('songs').delete(id);
          t.objectStore('fps').delete(id);
        });
      });
    },
    clearAll: function () {
      return openDb().then(function (db) {
        return tx(db, ['songs', 'fps'], 'readwrite', function (t) {
          t.objectStore('songs').clear();
          t.objectStore('fps').clear();
        });
      });
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FpDB = api;
})(typeof self !== 'undefined' ? self : globalThis);
