import Automerge
import Foundation

public struct SwiftNativeScenarioResult: Codable, Sendable {
    public let number: Int
    public let name: String
    public let status: String
    public let detail: String
}

public struct SwiftNativeScenarioSummary: Codable, Sendable {
    public let engine: String
    public let version: String
    public let pass: Int
    public let partial: Int
    public let fail: Int
    public let results: [SwiftNativeScenarioResult]

    public func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}

private struct NativeScenarioFailure: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw NativeScenarioFailure(message: message) }
}

private let fixedTime = Date(timeIntervalSince1970: 1_700_000_000)

private func actor(_ device: String) -> ActorId {
    ActorId(data: Data(("creative-cooking-" + device).utf8))!
}

private func seededDocument() throws -> Document {
    let doc = Document()
    doc.actor = actor("seed")

    let recipe = try doc.putObject(obj: .ROOT, key: "recipe", ty: .Map)
    try doc.put(obj: recipe, key: "title", value: .String("Tomato toast"))
    try doc.put(obj: recipe, key: "description", value: .String("A quick supper."))
    try doc.put(obj: recipe, key: "portions", value: .Int(2))
    try doc.put(obj: recipe, key: "deleted", value: .Boolean(false))
    try doc.put(obj: recipe, key: "deletedBy", value: .String(""))

    let ingredient = try doc.putObject(obj: recipe, key: "ingredient", ty: .Map)
    try doc.put(obj: ingredient, key: "name", value: .String("tomatoes"))
    try doc.put(obj: ingredient, key: "amount", value: .String("2"))

    let ingredientsById = try doc.putObject(obj: recipe, key: "ingredientsById", ty: .Map)
    let tomato = try doc.putObject(obj: ingredientsById, key: "ingredient-tomatoes", ty: .Map)
    try doc.put(obj: tomato, key: "name", value: .String("tomatoes"))
    try doc.put(obj: tomato, key: "amount", value: .String("2"))

    let ingredientOrder = try doc.putObject(obj: recipe, key: "ingredientOrder", ty: .List)
    try doc.insert(obj: ingredientOrder, index: 0, value: .String("ingredient-tomatoes"))
    try doc.insert(obj: ingredientOrder, index: 1, value: .String("ingredient-bread"))

    let method = try doc.putObject(obj: recipe, key: "method", ty: .Text)
    try doc.spliceText(obj: method, start: 0, delete: 0, value: "Chop onions and cook gently.")

    let chat = try doc.putObject(obj: .ROOT, key: "chat", ty: .List)
    try doc.insert(obj: chat, index: 0, value: .String("seed-message"))

    _ = try doc.putObject(obj: .ROOT, key: "allergies", ty: .Map)
    let pantry = try doc.putObject(obj: .ROOT, key: "pantry", ty: .Map)
    try doc.put(obj: pantry, key: "_schema", value: .String("stable-id-map"))

    let stepsById = try doc.putObject(obj: recipe, key: "stepsById", ty: .Map)
    let step1 = try doc.putObject(obj: stepsById, key: "step-1", ty: .Map)
    try doc.put(obj: step1, key: "text", value: .String("Chop onions."))
    let step2 = try doc.putObject(obj: stepsById, key: "step-2", ty: .Map)
    try doc.put(obj: step2, key: "text", value: .String("Toast the bread."))

    let stepOrder = try doc.putObject(obj: recipe, key: "stepOrder", ty: .List)
    try doc.insert(obj: stepOrder, index: 0, value: .String("step-1"))
    try doc.insert(obj: stepOrder, index: 1, value: .String("step-2"))

    doc.commitWith(message: #"{"device":"seed","action":"seed"}"#, timestamp: fixedTime)
    _ = doc.heads()
    return doc
}

private func fork(_ base: Document, device: String) -> Document {
    let result = base.fork()
    result.actor = actor(device)
    return result
}

private func object(_ doc: Document, parent: ObjId, key: String, type: ObjType) throws -> ObjId {
    guard let value = try doc.get(obj: parent, key: key) else {
        throw NativeScenarioFailure(message: "missing object \(key)")
    }
    guard case let .Object(id, actualType) = value, actualType == type else {
        throw NativeScenarioFailure(message: "\(key) is not \(type): \(value)")
    }
    return id
}

private func map(_ doc: Document, _ parent: ObjId, _ key: String) throws -> ObjId {
    try object(doc, parent: parent, key: key, type: .Map)
}

private func list(_ doc: Document, _ parent: ObjId, _ key: String) throws -> ObjId {
    try object(doc, parent: parent, key: key, type: .List)
}

private func textObject(_ doc: Document, _ parent: ObjId, _ key: String) throws -> ObjId {
    try object(doc, parent: parent, key: key, type: .Text)
}

private func string(_ doc: Document, _ objectId: ObjId, _ key: String) throws -> String {
    guard let value = try doc.get(obj: objectId, key: key), case let .Scalar(.String(result)) = value else {
        throw NativeScenarioFailure(message: "missing string \(key)")
    }
    return result
}

private func int(_ doc: Document, _ objectId: ObjId, _ key: String) throws -> Int64 {
    guard let value = try doc.get(obj: objectId, key: key), case let .Scalar(.Int(result)) = value else {
        throw NativeScenarioFailure(message: "missing int \(key)")
    }
    return result
}

private func bool(_ doc: Document, _ objectId: ObjId, _ key: String) throws -> Bool {
    guard let value = try doc.get(obj: objectId, key: key), case let .Scalar(.Boolean(result)) = value else {
        throw NativeScenarioFailure(message: "missing bool \(key)")
    }
    return result
}

private func listStrings(_ doc: Document, _ listId: ObjId) throws -> [String] {
    var result: [String] = []
    for index in 0..<doc.length(obj: listId) {
        guard let value = try doc.get(obj: listId, index: index), case let .Scalar(.String(item)) = value else {
            throw NativeScenarioFailure(message: "non-string list item at \(index)")
        }
        result.append(item)
    }
    return result
}

private func conflictInts(_ doc: Document, _ objectId: ObjId, _ key: String) throws -> Set<Int64> {
    let values = try doc.getAll(obj: objectId, key: key)
    var result = Set<Int64>()
    for value in values {
        guard case let .Scalar(.Int(item)) = value else {
            throw NativeScenarioFailure(message: "non-int conflict for \(key): \(value)")
        }
        result.insert(item)
    }
    return result
}

private func conflictStrings(_ doc: Document, _ objectId: ObjId, _ key: String) throws -> Set<String> {
    let values = try doc.getAll(obj: objectId, key: key)
    var result = Set<String>()
    for value in values {
        guard case let .Scalar(.String(item)) = value else {
            throw NativeScenarioFailure(message: "non-string conflict for \(key): \(value)")
        }
        result.insert(item)
    }
    return result
}

private func commit(_ doc: Document, device: String, action: String) {
    doc.commitWith(
        message: #"{"device":"#(device)","action":"#(action)"}"#,
        timestamp: fixedTime
    )
    _ = doc.heads()
}

@discardableResult
private func syncPair(_ left: Document, _ right: Document) throws -> (messages: Int, rounds: Int) {
    let leftState = SyncState()
    let rightState = SyncState()
    var messages = 0

    for round in 0..<50 {
        var sent = false
        if let message = left.generateSyncMessage(state: leftState) {
            try right.receiveSyncMessage(state: rightState, message: message)
            messages += 1
            sent = true
        }
        if let message = right.generateSyncMessage(state: rightState) {
            try left.receiveSyncMessage(state: leftState, message: message)
            messages += 1
            sent = true
        }
        if !sent { return (messages, round + 1) }
    }
    throw NativeScenarioFailure(message: "sync did not quiesce")
}

private func scenario(_ number: Int, _ name: String, _ body: () throws -> String) -> SwiftNativeScenarioResult {
    do {
        let detail = try body()
        return SwiftNativeScenarioResult(
            number: number,
            name: name,
            status: detail.hasPrefix("PARTIAL:") ? "PARTIAL" : "PASS",
            detail: detail
        )
    } catch {
        return SwiftNativeScenarioResult(number: number, name: name, status: "FAIL", detail: String(describing: error))
    }
}

public func runSwiftNativeCommonScenarioContract() -> SwiftNativeScenarioSummary {
    var results: [SwiftNativeScenarioResult] = []

    results.append(scenario(1, "different recipe fields") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "title", value: .String("Phone title"))
        commit(phone, device: "iphone", action: "title")
        try laptop.put(obj: map(laptop, .ROOT, "recipe"), key: "portions", value: .Int(4))
        commit(laptop, device: "macbook", action: "portions")
        try phone.merge(other: laptop)
        let recipe = try map(phone, .ROOT, "recipe")
        try require(string(phone, recipe, "title") == "Phone title", "title lost")
        try require(int(phone, recipe, "portions") == 4, "portions lost")
        try require(conflictInts(phone, recipe, "portions") == Set([4]), "false disagreement")
        return "compatible fields survive without scalar disagreement"
    })

    results.append(scenario(2, "same nested entity, different properties") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        let phoneIngredient = try map(phone, map(phone, .ROOT, "recipe"), "ingredient")
        let laptopIngredient = try map(laptop, map(laptop, .ROOT, "recipe"), "ingredient")
        try phone.put(obj: phoneIngredient, key: "amount", value: .String("3"))
        commit(phone, device: "iphone", action: "ingredient amount")
        try laptop.put(obj: laptopIngredient, key: "name", value: .String("tomatoes (ripe)"))
        commit(laptop, device: "macbook", action: "ingredient qualifier")
        try phone.merge(other: laptop)
        let ingredient = try map(phone, map(phone, .ROOT, "recipe"), "ingredient")
        try require(string(phone, ingredient, "amount") == "3", "amount lost")
        try require(string(phone, ingredient, "name") == "tomatoes (ripe)", "name lost")
        return "same stable nested entity merges independent properties"
    })

    results.append(scenario(3, "concurrent additions") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        let phoneOrder = try list(phone, map(phone, .ROOT, "recipe"), "ingredientOrder")
        let laptopOrder = try list(laptop, map(laptop, .ROOT, "recipe"), "ingredientOrder")
        try phone.insert(obj: phoneOrder, index: phone.length(obj: phoneOrder), value: .String("ingredient-basil"))
        commit(phone, device: "iphone", action: "add basil")
        try laptop.insert(obj: laptopOrder, index: laptop.length(obj: laptopOrder), value: .String("ingredient-garlic"))
        commit(laptop, device: "macbook", action: "add garlic")
        let reverse = fork(laptop, device: "ipad")
        try reverse.merge(other: phone)
        try phone.merge(other: laptop)
        let a = try listStrings(phone, list(phone, map(phone, .ROOT, "recipe"), "ingredientOrder"))
        let b = try listStrings(reverse, list(reverse, map(reverse, .ROOT, "recipe"), "ingredientOrder"))
        try require(a.contains("ingredient-basil") && a.contains("ingredient-garlic"), "addition lost")
        try require(a == b, "ordering depends on merge direction")
        return "deterministic merged order=\(a)"
    })

    results.append(scenario(4, "concurrent text editing") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        let phoneMethod = try textObject(phone, map(phone, .ROOT, "recipe"), "method")
        let laptopMethod = try textObject(laptop, map(laptop, .ROOT, "recipe"), "method")
        try phone.spliceText(obj: phoneMethod, start: 11, delete: 0, value: " finely")
        commit(phone, device: "iphone", action: "text middle")
        let laptopLength = laptop.length(obj: laptopMethod)
        try laptop.spliceText(obj: laptopMethod, start: laptopLength - 1, delete: 0, value: " until golden")
        commit(laptop, device: "macbook", action: "text end")
        try phone.merge(other: laptop)
        let merged = try phone.text(obj: textObject(phone, map(phone, .ROOT, "recipe"), "method"))
        try require(merged.contains("finely") && merged.contains("until golden"), "text edit lost")
        return "exact text=\(merged)"
    })

    results.append(scenario(5, "chat appends") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        let phoneChat = try list(phone, .ROOT, "chat")
        let laptopChat = try list(laptop, .ROOT, "chat")
        try phone.insert(obj: phoneChat, index: phone.length(obj: phoneChat), value: .String("phone-message"))
        commit(phone, device: "iphone", action: "chat append")
        try laptop.insert(obj: laptopChat, index: laptop.length(obj: laptopChat), value: .String("laptop-message"))
        commit(laptop, device: "macbook", action: "chat append")
        try phone.merge(other: laptop)
        let messages = try listStrings(phone, list(phone, .ROOT, "chat"))
        try require(messages.contains("phone-message") && messages.contains("laptop-message"), "chat append lost")
        return "messages=\(messages)"
    })

    results.append(scenario(6, "set-like additions") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        try phone.put(obj: map(phone, .ROOT, "allergies"), key: "peanuts", value: .Boolean(true))
        commit(phone, device: "iphone", action: "allergy peanuts")
        try laptop.put(obj: map(laptop, .ROOT, "allergies"), key: "sesame", value: .Boolean(true))
        commit(laptop, device: "macbook", action: "allergy sesame")
        try phone.merge(other: laptop)
        let allergies = try map(phone, .ROOT, "allergies")
        try require(bool(phone, allergies, "peanuts"), "peanuts lost")
        try require(bool(phone, allergies, "sesame"), "sesame lost")
        return "both map-as-set additions survive"
    })

    results.append(scenario(7, "same scalar disagreement") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "portions", value: .Int(4))
        commit(phone, device: "iphone", action: "portions 4")
        try laptop.put(obj: map(laptop, .ROOT, "recipe"), key: "portions", value: .Int(6))
        commit(laptop, device: "macbook", action: "portions 6")
        try phone.merge(other: laptop)
        let recipe = try map(phone, .ROOT, "recipe")
        try require(conflictInts(phone, recipe, "portions") == Set([4, 6]), "both alternatives not retained")
        let conflictingHeads = phone.heads()
        try require(conflictingHeads.count == 2, "expected two concurrent heads")

        let relevantChanges = phone.getHistory().compactMap { phone.change(hash: $0) }
            .filter { $0.actorId == actor("iphone") || $0.actorId == actor("macbook") }
        let phoneChange = relevantChanges.last { $0.actorId == actor("iphone") }
        let laptopChange = relevantChanges.last { $0.actorId == actor("macbook") }
        try require(phoneChange != nil && laptopChange != nil, "device change metadata missing")
        try require(!phoneChange!.deps.contains(laptopChange!.hash), "phone change depends on laptop")
        try require(!laptopChange!.deps.contains(phoneChange!.hash), "laptop change depends on phone")

        let resolver = fork(phone, device: "ipad")
        try resolver.put(obj: map(resolver, .ROOT, "recipe"), key: "portions", value: .Int(5))
        commit(resolver, device: "ipad", action: "resolve portions")
        try require(conflictInts(resolver, map(resolver, .ROOT, "recipe"), "portions") == Set([5]), "resolution did not supersede both")
        let resolvedHeads = resolver.heads()
        try require(resolvedHeads.count == 1, "resolution should return to one head")
        guard let resolutionHash = resolvedHeads.first, let resolution = resolver.change(hash: resolutionHash) else {
            throw NativeScenarioFailure(message: "resolution metadata missing")
        }
        try require(Set(resolution.deps).isSuperset(of: conflictingHeads), "resolution does not depend on both conflicting heads")
        try require(resolution.actorId == actor("ipad"), "resolution device metadata missing")
        return "alternatives=[4,6], devices=[iphone,macbook], resolution=5 by ipad with causal deps on both heads"
    })

    results.append(scenario(8, "same atomic title") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "title", value: .String("Basil toast"))
        commit(phone, device: "iphone", action: "title basil")
        try laptop.put(obj: map(laptop, .ROOT, "recipe"), key: "title", value: .String("Garlic toast"))
        commit(laptop, device: "macbook", action: "title garlic")
        try phone.merge(other: laptop)
        let values = try conflictStrings(phone, map(phone, .ROOT, "recipe"), "title")
        try require(values == Set(["Basil toast", "Garlic toast"]), "title alternatives unavailable")
        return "both atomic titles remain reviewable"
    })

    results.append(scenario(9, "delete versus edit") {
        let base = try seededDocument()
        let physicalDelete = fork(base, device: "iphone")
        let physicalEdit = fork(base, device: "macbook")
        try physicalDelete.delete(obj: .ROOT, key: "recipe")
        commit(physicalDelete, device: "iphone", action: "physical delete")
        try physicalEdit.put(obj: map(physicalEdit, .ROOT, "recipe"), key: "title", value: .String("Edited offline"))
        commit(physicalEdit, device: "macbook", action: "edit deleted recipe")
        try physicalDelete.merge(other: physicalEdit)
        let physicalPresent = try physicalDelete.get(obj: .ROOT, key: "recipe") != nil

        let tombstoneDelete = fork(base, device: "iphone")
        let tombstoneEdit = fork(base, device: "macbook")
        let deleteRecipe = try map(tombstoneDelete, .ROOT, "recipe")
        try tombstoneDelete.put(obj: deleteRecipe, key: "deleted", value: .Boolean(true))
        try tombstoneDelete.put(obj: deleteRecipe, key: "deletedBy", value: .String("iphone"))
        commit(tombstoneDelete, device: "iphone", action: "tombstone")
        try tombstoneEdit.put(obj: map(tombstoneEdit, .ROOT, "recipe"), key: "title", value: .String("Edited offline"))
        commit(tombstoneEdit, device: "macbook", action: "edit recipe")
        try tombstoneDelete.merge(other: tombstoneEdit)
        let mergedRecipe = try map(tombstoneDelete, .ROOT, "recipe")
        try require(bool(tombstoneDelete, mergedRecipe, "deleted"), "tombstone lost")
        try require(string(tombstoneDelete, mergedRecipe, "title") == "Edited offline", "concurrent edit lost")
        return "physicalRenderedPresent=\(physicalPresent); tombstone + edit coexist for semantic review"
    })

    results.append(scenario(10, "duplicate pantry item") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        let phonePantry = try map(phone, .ROOT, "pantry")
        let laptopPantry = try map(laptop, .ROOT, "pantry")
        let p = try phone.putObject(obj: phonePantry, key: "carrots-phone", ty: .Map)
        try phone.put(obj: p, key: "normalizedName", value: .String("carrots"))
        try phone.put(obj: p, key: "preference", value: .Int(5))
        commit(phone, device: "iphone", action: "add carrots")
        let l = try laptop.putObject(obj: laptopPantry, key: "carrots-laptop", ty: .Map)
        try laptop.put(obj: l, key: "normalizedName", value: .String("carrots"))
        try laptop.put(obj: l, key: "preference", value: .Int(2))
        commit(laptop, device: "macbook", action: "add carrots")
        try phone.merge(other: laptop)
        let pantry = try map(phone, .ROOT, "pantry")
        let mergedP = try map(phone, pantry, "carrots-phone")
        let mergedL = try map(phone, pantry, "carrots-laptop")
        try require(int(phone, mergedP, "preference") == 5, "phone preference lost")
        try require(int(phone, mergedL, "preference") == 2, "laptop preference lost")
        return "both logical duplicates and preferences 5/2 preserved; application dedupe required"
    })

    results.append(scenario(11, "reorder plus edit") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        let phoneRecipe = try map(phone, .ROOT, "recipe")
        let order = try list(phone, phoneRecipe, "stepOrder")
        try phone.delete(obj: order, index: 1)
        try phone.insert(obj: order, index: 0, value: .String("step-2"))
        commit(phone, device: "iphone", action: "reorder steps")

        let laptopRecipe = try map(laptop, .ROOT, "recipe")
        let steps = try map(laptop, laptopRecipe, "stepsById")
        let step2 = try map(laptop, steps, "step-2")
        try laptop.put(obj: step2, key: "text", value: .String("Toast the bread until deeply golden."))
        commit(laptop, device: "macbook", action: "edit step")
        try phone.merge(other: laptop)

        let mergedRecipe = try map(phone, .ROOT, "recipe")
        let mergedOrder = try listStrings(phone, list(phone, mergedRecipe, "stepOrder"))
        let mergedStep2 = try map(phone, map(phone, mergedRecipe, "stepsById"), "step-2")
        try require(mergedOrder.first == "step-2", "reorder lost")
        try require(string(phone, mergedStep2, "text") == "Toast the bread until deeply golden.", "stable step edit lost")
        return "order=\(mergedOrder); stable step edit survives"
    })

    results.append(scenario(12, "restart") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "description", value: .String("Edited before restart."))
        commit(phone, device: "iphone", action: "pre-restart edit")
        let saved = phone.save()
        let restarted = try Document(saved)
        restarted.actor = actor("ipad")
        try restarted.put(obj: map(restarted, .ROOT, "recipe"), key: "title", value: .String("Restart-safe toast"))
        commit(restarted, device: "ipad", action: "post-restart edit")
        let recipe = try map(restarted, .ROOT, "recipe")
        try require(string(restarted, recipe, "description") == "Edited before restart.", "pre-restart edit lost")
        try require(string(restarted, recipe, "title") == "Restart-safe toast", "post-restart edit lost")
        return "savedBytes=\(saved.count); reload and continued edits succeed"
    })

    results.append(scenario(13, "out-of-order delivery") {
        let base = try seededDocument()
        let baseHeads = base.heads()
        let phone = fork(base, device: "iphone")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "description", value: .String("First causal edit."))
        commit(phone, device: "iphone", action: "first causal edit")
        let firstHeads = phone.heads()
        let first = try phone.encodeChangesSince(heads: baseHeads)
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "title", value: .String("Second causal edit"))
        commit(phone, device: "iphone", action: "second causal edit")
        let second = try phone.encodeChangesSince(heads: firstHeads)

        let receiver = try Document(base.save())
        receiver.actor = actor("ipad")
        try receiver.applyEncodedChanges(encoded: second)
        try receiver.applyEncodedChanges(encoded: first)
        let recipe = try map(receiver, .ROOT, "recipe")
        try require(string(receiver, recipe, "description") == "First causal edit.", "first change missing")
        try require(string(receiver, recipe, "title") == "Second causal edit", "second change missing")
        return "dependency-late encoded changes converge"
    })

    results.append(scenario(14, "duplicate delivery") {
        let base = try seededDocument()
        let baseHeads = base.heads()
        let phone = fork(base, device: "iphone")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "title", value: .String("Idempotent toast"))
        commit(phone, device: "iphone", action: "single edit")
        let encoded = try phone.encodeChangesSince(heads: baseHeads)

        let receiver = try Document(base.save())
        receiver.actor = actor("ipad")
        try receiver.applyEncodedChanges(encoded: encoded)
        let onceHeads = receiver.heads()
        try receiver.applyEncodedChanges(encoded: encoded)
        try require(receiver.heads() == onceHeads, "duplicate change altered heads")
        try require(string(receiver, map(receiver, .ROOT, "recipe"), "title") == "Idempotent toast", "duplicate delivery changed value")
        return "duplicate encoded changes are idempotent"
    })

    results.append(scenario(15, "long offline divergence") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")

        let phoneRecipe = try map(phone, .ROOT, "recipe")
        try phone.put(obj: phoneRecipe, key: "title", value: .String("Phone toast"))
        let phoneIngredients = try map(phone, phoneRecipe, "ingredientsById")
        let basil = try phone.putObject(obj: phoneIngredients, key: "ingredient-basil", ty: .Map)
        try phone.put(obj: basil, key: "name", value: .String("basil"))
        try phone.put(obj: basil, key: "amount", value: .String("1 handful"))
        try phone.put(obj: phoneRecipe, key: "portions", value: .Int(4))
        commit(phone, device: "iphone", action: "offline batch")

        let laptopRecipe = try map(laptop, .ROOT, "recipe")
        try laptop.put(obj: laptopRecipe, key: "description", value: .String("Laptop description"))
        let laptopIngredients = try map(laptop, laptopRecipe, "ingredientsById")
        let garlic = try laptop.putObject(obj: laptopIngredients, key: "ingredient-garlic", ty: .Map)
        try laptop.put(obj: garlic, key: "name", value: .String("garlic"))
        try laptop.put(obj: garlic, key: "amount", value: .String("1 clove"))
        try laptop.put(obj: laptopRecipe, key: "portions", value: .Int(6))
        commit(laptop, device: "macbook", action: "offline batch")

        try phone.merge(other: laptop)
        let recipe = try map(phone, .ROOT, "recipe")
        let ingredients = try map(phone, recipe, "ingredientsById")
        _ = try map(phone, ingredients, "ingredient-basil")
        _ = try map(phone, ingredients, "ingredient-garlic")
        try require(conflictInts(phone, recipe, "portions") == Set([4, 6]), "offline disagreement lost")
        try require(string(phone, recipe, "title") == "Phone toast", "phone clean edit lost")
        try require(string(phone, recipe, "description") == "Laptop description", "laptop clean edit lost")
        return "eventual merge keeps clean edits plus portions [4,6] disagreement"
    })

    results.append(scenario(16, "merge direction") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "title", value: .String("A title"))
        commit(phone, device: "iphone", action: "title A")
        try laptop.put(obj: map(laptop, .ROOT, "recipe"), key: "title", value: .String("B title"))
        commit(laptop, device: "macbook", action: "title B")
        let ab = fork(phone, device: "ipad")
        let ba = fork(laptop, device: "seed")
        try ab.merge(other: laptop)
        try ba.merge(other: phone)
        let a = try conflictStrings(ab, map(ab, .ROOT, "recipe"), "title")
        let b = try conflictStrings(ba, map(ba, .ROOT, "recipe"), "title")
        try require(a == b && a == Set(["A title", "B title"]), "merge directions differ")
        return "equivalent logical conflict set in both directions"
    })

    results.append(scenario(17, "sync protocol") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "title", value: .String("Synced phone title"))
        commit(phone, device: "iphone", action: "sync title")
        try laptop.put(obj: map(laptop, .ROOT, "recipe"), key: "description", value: .String("Synced laptop description"))
        commit(laptop, device: "macbook", action: "sync description")
        let stats = try syncPair(phone, laptop)
        try require(phone.heads() == laptop.heads(), "sync heads differ")
        try require(string(phone, map(phone, .ROOT, "recipe"), "title") == "Synced phone title", "phone title lost")
        try require(string(laptop, map(laptop, .ROOT, "recipe"), "title") == "Synced phone title", "laptop missing phone title")
        try require(string(phone, map(phone, .ROOT, "recipe"), "description") == "Synced laptop description", "phone missing laptop description")
        return "actual Swift SyncState APIs converge; messages=\(stats.messages), rounds=\(stats.rounds)"
    })

    results.append(scenario(18, "three replicas") {
        let base = try seededDocument()
        let phone = fork(base, device: "iphone")
        let laptop = fork(base, device: "macbook")
        let ipad = fork(base, device: "ipad")
        try phone.put(obj: map(phone, .ROOT, "recipe"), key: "title", value: .String("Three-way toast"))
        commit(phone, device: "iphone", action: "three title")
        try laptop.put(obj: map(laptop, .ROOT, "recipe"), key: "description", value: .String("Three replicas"))
        commit(laptop, device: "macbook", action: "three description")
        try ipad.put(obj: map(ipad, .ROOT, "allergies"), key: "sesame", value: .Boolean(true))
        commit(ipad, device: "ipad", action: "three allergy")

        try syncPair(phone, laptop)
        try syncPair(laptop, ipad)
        try syncPair(ipad, phone)
        try syncPair(phone, laptop)
        try require(phone.heads() == laptop.heads() && laptop.heads() == ipad.heads(), "three replicas did not converge")
        try require(string(phone, map(phone, .ROOT, "recipe"), "title") == "Three-way toast", "title lost")
        try require(string(ipad, map(ipad, .ROOT, "recipe"), "description") == "Three replicas", "description lost")
        try require(bool(laptop, map(laptop, .ROOT, "allergies"), "sesame"), "allergy lost")
        return "three native Swift replicas converge"
    })

    let pass = results.filter { $0.status == "PASS" }.count
    let partial = results.filter { $0.status == "PARTIAL" }.count
    let fail = results.filter { $0.status == "FAIL" }.count
    return SwiftNativeScenarioSummary(
        engine: "automerge-swift",
        version: "0.7.2",
        pass: pass,
        partial: partial,
        fail: fail,
        results: results
    )
}
