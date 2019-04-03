'use strict'
const { Range, Selection } = require('./Selection.js')
const TextOperation = require('./TextOperation.js')
const WrappedOperation = require('./WrappedOperation.js')

class Server {
  // Constructor. Takes the current document as a string and optionally the array of all operations.
  constructor (document, operations) {
    this.document = document
    this.operations = operations || []
  }
  // Call this method whenever you receive an operation from a client.
  receiveOperation (revision, operation) {
    if (revision < 0 || this.operations.length < revision) {
      // TODO ...
      throw new Error('operation revision not in history')
    }
    // Find all operations that the client didn't know of when it sent the
    // operation ...
    var concurrentOperations = this.operations.slice(revision)

    // ... and transform the operation against all these operations ...
    for (var i = 0; i < concurrentOperations.length; i++) {
      operation = WrappedOperation.transform(operation, concurrentOperations[i])[0]
    }

    // ... and apply that on the document.
    this.document = operation.apply(this.document)
    // Store operation in history.
    this.operations.push(operation)

    // It's the caller's responsibility to send the operation to all connected
    // clients and an acknowledgement to the creator.
    return operation
  }
}

module.exports =
class SharedPenServer extends Server {
  constructor (document, operations, docId, mayWrite) {
    super(document, operations)
    this.docId = docId
    this.clients = {}
    // TODO ... 文档权限控制
    if (mayWrite) {
      this.mayWrite = mayWrite
    } else {
      this.mayWrite = (_, cb) => {
        var vle = true  //这里默认全都有权限
        cb && cb(vle)
      }
    }
  }
  //连接服务器触发这个函数，然后根据ID，socket加入分组（join），然后触发前端注册的doc事件，并把输入传给事件注册函数，数据包括文档，版本(操作的长度)，其他客户端，操作集
  addClient (socket) {
    socket
      .join(this.docId)
      .emit('doc', {
        document: this.document,
        revision: this.operations.length,
        clients: this.clients,
        // replay the operations on the clients, so the rich text will show correctly
        operations: this.operations
      })
      .on('operation', (revision, operation, selection) => {
        this.mayWrite(socket, (mayWrite) => {
          if (!mayWrite) {
            console.log("User doesn't have the right to edit.")
            return
          }
          this.onOperation(socket, revision, operation, selection)
        })
      })
      .on('selection', (obj) => {
        this.mayWrite(socket, (mayWrite) => {
          if (!mayWrite) {
            console.log("User doesn't have the right to edit.")
            return
          }
          this.updateSelection(socket, obj && Selection.fromJSON(obj))
        })
      })
      .on('disconnect', () => {
        console.log('Disconnect')
        socket.leave(this.docId)
        this.onDisconnect(socket)
        // TODO ...
        // if (
        //   (socket.manager && socket.manager.sockets.clients(this.docId).length === 0) || // socket.io <= 0.9
        //   (socket.ns && Object.keys(socket.ns.connected).length === 0) // socket.io >= 1.0
        // ) {
        //   this.emit('empty-room');
        // }
      })
    //把socket的id作为客户端用户id，name也是，selection是什么东西暂不清楚，大概是用户鼠标所处位置
    this.clients[socket.id] = {
      id: socket.id,
      name: socket.id,
      selection: new Selection([new Range(0, 0)])
    }
    //对这个docId的用户广播加入事件给同组的其他前端(客户端)，并且把这个客户端信息传递给其他前端
    socket.broadcast['in'](this.docId).emit('client_join', this.clients[socket.id])
  }
  onOperation (socket, revision, operation, selection) {
    var wrapped
    try {
      wrapped = new WrappedOperation(
        TextOperation.fromJSON(operation),
        selection && Selection.fromJSON(selection)
      )
    } catch (exc) {
      console.error('Invalid operation received: ' + exc)
      return
    }
    try {
      var clientId = socket.id
      var wrappedPrime = this.receiveOperation(revision, wrapped)
      console.log('new operation: ' + wrapped)
      this.getClient(clientId).selection = wrappedPrime.meta
      socket.emit('ack')
      socket.broadcast['in'](this.docId).emit(
        'operation',
        clientId,
        wrappedPrime.wrapped.toJSON(),
        wrappedPrime.meta
      )
    } catch (exc) {
      console.error(exc)
    }
  }
  updateSelection (socket, selection) {
    var clientId = socket.id
    if (selection) {
      this.getClient(clientId).selection = selection
    }
    socket.broadcast['in'](this.docId).emit('selection', clientId, selection)
  }

  setName (socket, name) {
    var clientId = socket.id
    this.getClient(clientId).name = name
    socket.broadcast['in'](this.docId).emit('set_name', clientId, name)
  }
  getClient (clientId) {
    return this.clients[clientId] || (this.clients[clientId] = {})
  }
  onDisconnect (socket) {
    var clientId = socket.id
    delete this.clients[clientId]
    socket.broadcast['in'](this.docId).emit('client_left', clientId)
  }
}
