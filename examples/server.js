var express = require('express')
var app = express()
var http = require('http').Server(app)
var io = require('socket.io')(http)
// var cors = require('cors')
// var path = require('path')

http.listen(4000, function () {
    console.log('listening on *:4000')
})
var EditorSocketIOServer = require('../build/SharedPenServer.js')
var server = new EditorSocketIOServer('', [], 1)    //修改：点击文档后获取数据库存储的富文本作为第一个参数，文档id作为第三个参数

io.on('connection', function (socket) { //每次连接都会产生一个新socket
    server.addClient(socket)
})
