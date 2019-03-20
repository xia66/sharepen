'use strict'
const Utils = require('./Utils.js')
const { Range, Selection } = require('./Selection.js')
const TextOperation = require('./TextOperation.js')
const WrappedOperation = require('./WrappedOperation.js')

function minPos (a, b) { return Utils.posLe(a, b) ? a : b }
function maxPos (a, b) { return Utils.posLe(a, b) ? b : a }
// codemirror current length
function codemirrorLength (cm) {
  var lastLine = cm.lineCount() - 1
  return cm.indexFromPos({
    line: lastLine,
    ch: cm.getLine(lastLine).length
  })
}
var addStyleRule = (function () {
  var added = {}
  var styleSheet

  return function (css) {
    if (added[css]) { return }
    added[css] = true

    if (!styleSheet) {
      var styleElement = document.createElement('style')
      var root = document.documentElement.getElementsByTagName('head')[0]
      root.appendChild(styleElement)
      styleSheet = styleElement.sheet
    }
    styleSheet.insertRule(css, (styleSheet.cssRules || styleSheet.rules).length)
  }
}())

// editor adapter
module.exports =
class RichTextCodeMirrorAdapter {
  // cmtm: instance of RichTextCodeMirror
  // cm: instance of CodeMirror
  constructor (rtcm) {
    this.rtcm = rtcm
    this.cm = rtcm.codeMirror

    this.rtcm.on('change', this.onChange, this)
    this.rtcm.on('attributesChange', this.onAttributesChange, this)

    this.cm.on('beforeChange', this.trigger.bind(this, 'beforeChange'))
    this.cm.on('cursorActivity', this.onCursorActivity.bind(this))
    this.cm.on('focus', this.onFocus.bind(this))
    this.cm.on('blur', this.onBlur.bind(this))
  }
  // Removes all event listeners from the CodeMirrorror instance.
  detach () {
    this.rtcm.off('change', this.onChange)
    this.rtcm.off('attributesChange', this.onAttributesChange)

    this.cm.off('cursorActivity', this.onCursorActivity.bind(this))
    this.cm.off('focus', this.onFocus.bind(this))
    this.cm.off('blur', this.onBlur.bind(this))
  }
  onChange (_, changes) {
    if (changes[0].origin !== 'RTCMADAPTER') {
      var pair = RichTextCodeMirrorAdapter.operationFromCodeMirrorChanges(changes, this.cm)
      //触发在editclient里调用这里的registerCallback函数注册的事件和回调函数，注册在this.callbacks对象
      //所以trigger里调用的是这里的this.callbacks[event]
      this.trigger('change', pair[0], pair[1])  //pair[0]是操作，pair[1]是这个操作的逆操作
    }
  }
  onAttributesChange (_, changes) {
    console.log(changes) //changes是数组，按照选中区域不同的样式进行分段
    if (changes[0].origin !== 'RTCMADAPTER') {
      var pair = RichTextCodeMirrorAdapter.operationFromAttributesChanges(changes, this.cm)
      this.trigger('change', pair[0], pair[1])
    }
  }
  onCursorActivity () {
    this.trigger('selectionChange')
  }
  onFocus () {
    this.trigger('focus')
  }
  onBlur () {
    if (!this.cm.somethingSelected()) {
      this.trigger('blur')
    }
  }
  //触发事件
  trigger (event) {
    var args = Array.prototype.slice.call(arguments, 1)
    var action = this.callbacks && this.callbacks[event]
    if (action) {
      action.apply(this, args)
    }
  }
  //注册回调事件，在editClient调用
  registerCallbacks (cbs) {
    this.callbacks = cbs
  }
  registerUndo (fn) {
    this.cm.undo = fn
  }
  registerRedo (fn) {
    this.cm.redo = fn
  }

  getSelection () {
    var cm = this.cm

    var selectionList = cm.listSelections()
    var ranges = []
    for (var i = 0; i < selectionList.length; i++) {
      ranges[i] = new Range(
        cm.indexFromPos(selectionList[i].anchor),
        cm.indexFromPos(selectionList[i].head)
      )
    }

    return new Selection(ranges)
  }
  setSelection (selection) {
    var ranges = []
    for (var i = 0; i < selection.ranges.length; i++) {
      var range = selection.ranges[i]
      ranges[i] = {
        anchor: this.cm.posFromIndex(range.anchor),
        head: this.cm.posFromIndex(range.head)
      }
    }
    this.cm.setSelections(ranges)
  }

  //将CodeMirror更改对象转换为操作及其逆操作
  //并将它们作为一个双元素数组返回。
  static operationFromCodeMirrorChanges (changes, cm) {
  //方法:重播更改，从最近的更改开始，并且
  //构造运算及其逆矩阵。我们必须转换位置
  //在一个索引的预更改坐标系中。我们有一个方法
  //将坐标系统中的一个位置转换为一个索引，
  //也就是CodeMirror的' indexFromPos '方法。我们可以利用的信息
  //将变更后的坐标系统转换为a的单个变更对象
  //预先更改坐标系。我们现在可以归纳得到a
  //为链表中的所有更改预先更改坐标系统。
  //这种方法的缺点是它在长度上的复杂度' O(n²)'
  //更改的链表。
    var docEndLength = codemirrorLength(cm)
    var operation = new TextOperation().retain(docEndLength)
    var inverse = new TextOperation().retain(docEndLength)

    for (var i = changes.length - 1; i >= 0; i--) {
      var change = changes[i]
      var fromIndex = change.start
      var restLength = docEndLength - fromIndex - change.text.length

      operation = new TextOperation()
        .retain(fromIndex)
        .delete(change.removed.length)
        .insert(change.text, change.attributes)
        .retain(restLength)
        .compose(operation)

      inverse = inverse.compose(
        new TextOperation()
          .retain(fromIndex)
          .delete(change.text.length)
          .insert(change.removed, change.removedAttributes)
          .retain(restLength)
      )

      docEndLength += change.removed.length - change.text.length
    }
    return [operation, inverse]
  }
  // Converts an attributes changed object to an operation and its inverse.
  static operationFromAttributesChanges (changes, cm) {
    var docEndLength = codemirrorLength(cm)

    var operation = new TextOperation()
    var inverse = new TextOperation()
    var pos = 0

    for (var i = 0; i < changes.length; i++) {
      var change = changes[i]
      var toRetain = change.start - pos
      Utils.assert(toRetain >= 0) // changes should be in order and non-overlapping.
      operation.retain(toRetain)
      inverse.retain(toRetain)

      var length = change.end - change.start
      operation.retain(length, change.attributes)
      inverse.retain(length, change.attributesInverse)
      pos = change.start + length
    }

    operation.retain(docEndLength - pos)
    inverse.retain(docEndLength - pos)
    return [operation, inverse]
  }

  // Apply an operation to a CodeMirror instance.
  applyOperation (operation) {
    // HACK: If there are a lot of operations; hide CodeMirror so that it doesn't re-render constantly.
    if (operation.ops.length > 10) {
      this.rtcm.codeMirror.getWrapperElement().setAttribute('style', 'display: none')
    }

    var ops = operation.ops
    var index = 0 // holds the current index into CodeMirror's content
    for (var i = 0, l = ops.length; i < l; i++) {
      var op = ops[i]
      if (op.isRetain()) {
        if (!Utils.emptyAttributes(op.attributes)) {
          this.rtcm.updateTextAttributes(index, index + op.chars, function (attributes) {
            for (var attr in op.attributes) {
              if (op.attributes[attr] === false) {
                delete attributes[attr]
              } else {
                attributes[attr] = op.attributes[attr]
              }
            }
          }, 'RTCMADAPTER', /* doLineAttributes= */true)
        }
        index += op.chars
      } else if (op.isInsert()) {
        this.rtcm.insertText(index, op.text, op.attributes, 'RTCMADAPTER')
        index += op.text.length
      } else if (op.isDelete()) {
        this.rtcm.removeText(index, index + op.chars, 'RTCMADAPTER')
      }
    }

    if (operation.ops.length > 10) {
      this.rtcm.codeMirror.getWrapperElement().setAttribute('style', '')
      this.rtcm.codeMirror.refresh()
    }
  }
  invertOperation (operation) {
    var pos = 0
    var cm = this.rtcm.codeMirror
    var spans
    var i
    var inverse = new TextOperation()
    for (var opIndex = 0; opIndex < operation.wrapped.ops.length; opIndex++) {
      var op = operation.wrapped.ops[opIndex]
      if (op.isRetain()) {
        if (Utils.emptyAttributes(op.attributes)) {
          inverse.retain(op.chars)
          pos += op.chars
        } else {
          spans = this.rtcm.getAttributeSpans(pos, pos + op.chars)
          for (i = 0; i < spans.length; i++) {
            var inverseAttributes = {}
            for (var attr in op.attributes) {
              var opValue = op.attributes[attr]
              var curValue = spans[i].attributes[attr]

              if (opValue === false) {
                if (curValue) {
                  inverseAttributes[attr] = curValue
                }
              } else if (opValue !== curValue) {
                inverseAttributes[attr] = curValue || false
              }
            }

            inverse.retain(spans[i].length, inverseAttributes)
            pos += spans[i].length
          }
        }
      } else if (op.isInsert()) {
        inverse.delete(op.text.length)
      } else if (op.isDelete()) {
        var text = cm.getRange(cm.posFromIndex(pos), cm.posFromIndex(pos + op.chars))

        spans = this.rtcm.getAttributeSpans(pos, pos + op.chars)
        var delTextPos = 0
        for (i = 0; i < spans.length; i++) {
          inverse.insert(text.substr(delTextPos, spans[i].length), spans[i].attributes)
          delTextPos += spans[i].length
        }

        pos += op.chars
      }
    }

    return new WrappedOperation(inverse, operation.meta.invert())
  }

  setOtherSelection (selection, color, clientId) {
    var selectionObjects = []
    for (var i = 0; i < selection.ranges.length; i++) {
      var range = selection.ranges[i]
      if (range.isEmpty()) { // cursor
        selectionObjects[i] = this.setOtherCursor(range.head, color, clientId)
      } else { // selection
        selectionObjects[i] = this.setOtherSelectionRange(range, color, clientId)
      }
    }
    return {
      clear: function () {
        for (var i = 0; i < selectionObjects.length; i++) {
          selectionObjects[i].clear()
        }
      }
    }
  }
  setOtherCursor (position, color, clientId) {
    var cursorPos = this.cm.posFromIndex(position)
    var cursorCoords = this.cm.cursorCoords(cursorPos)
    var cursorEl = document.createElement('span')
    cursorEl.className = 'other-client'
    cursorEl.style.display = 'inline'
    cursorEl.style.padding = '0'
    cursorEl.style.marginLeft = cursorEl.style.marginRight = '-1px'
    cursorEl.style.borderLeftWidth = '2px'
    cursorEl.style.borderLeftStyle = 'solid'
    cursorEl.style.borderLeftColor = color
    cursorEl.style.height = (cursorCoords.bottom - cursorCoords.top) + 'px'
    cursorEl.style.transform = 'translateY(2px)'
    cursorEl.style.zIndex = 0
    cursorEl.setAttribute('data-clientid', clientId)
    return this.cm.setBookmark(cursorPos, { widget: cursorEl, insertLeft: true })
  }
  setOtherSelectionRange (range, color, clientId) {
    var match = /^#([0-9a-fA-F]{6})$/.exec(color)
    if (!match) { throw new Error('only six-digit hex colors are allowed.') }
    var selectionClassName = 'selection-' + match[1]
    var rule = '.' + selectionClassName + ' { background: ' + color + '; }'
    addStyleRule(rule)

    var anchorPos = this.cm.posFromIndex(range.anchor)
    var headPos = this.cm.posFromIndex(range.head)

    return this.cm.markText(
      minPos(anchorPos, headPos),
      maxPos(anchorPos, headPos),
      { className: selectionClassName }
    )
  }
}
