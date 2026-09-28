import Foundation

// JSONL protocol plumbing shared by the whole helper. One request per stdin
// line: {"id":1,"cmd":"app_state","args":{...}} -> one stdout line
// {"id":1,"ok":true,"result":{...}} or {"id":1,"ok":false,"error":"..."}.
// Anything diagnostic goes to stderr — stdout carries protocol only.

struct HelperError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

func argString(_ args: [String: Any], _ key: String) -> String? {
    args[key] as? String
}

func argNumber(_ args: [String: Any], _ key: String) -> Double? {
    (args[key] as? NSNumber)?.doubleValue
}

func argInt(_ args: [String: Any], _ key: String) -> Int? {
    (args[key] as? NSNumber)?.intValue
}

func argBool(_ args: [String: Any], _ key: String) -> Bool {
    (args[key] as? NSNumber)?.boolValue ?? false
}

func writeResponse(id: Any, result: Any?, error: String?) {
    var body: [String: Any] = ["id": id, "ok": error == nil]
    if let result = result {
        body["result"] = result
    }
    if let error = error {
        body["error"] = error
    }
    let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func logStderr(_ message: String) {
    FileHandle.standardError.write(Data("cua-helper: \(message)\n".utf8))
}
