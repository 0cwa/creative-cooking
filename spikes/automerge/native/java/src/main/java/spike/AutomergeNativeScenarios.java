package spike;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import org.automerge.AmValue;
import org.automerge.ChangeHash;
import org.automerge.Conflicts;
import org.automerge.Document;
import org.automerge.ObjectId;
import org.automerge.ObjectType;
import org.automerge.SyncState;
import org.automerge.Transaction;

public final class AutomergeNativeScenarios {
    private AutomergeNativeScenarios() {}

    public record ScenarioResult(int number, String name, String status, String detail) {}
    public record ScenarioSummary(int pass, int partial, int fail, List<ScenarioResult> results) {}

    @FunctionalInterface
    interface Scenario {
        String run() throws Exception;
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static byte[] actor(String value) {
        return ("creative-cooking-" + value).getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    private static Document seed() {
        Document doc = new Document(actor("seed"));
        try (Transaction tx = doc.startTransaction()) {
            ObjectId recipe = tx.set(ObjectId.ROOT, "recipe", ObjectType.MAP);
            tx.set(recipe, "title", "Tomato toast");
            tx.set(recipe, "description", "A quick supper.");
            tx.set(recipe, "portions", 2);
            tx.set(recipe, "deleted", false);
            tx.set(recipe, "deletedBy", "");

            ObjectId ingredient = tx.set(recipe, "ingredient", ObjectType.MAP);
            tx.set(ingredient, "name", "tomatoes");
            tx.set(ingredient, "amount", "2");

            ObjectId ingredients = tx.set(recipe, "ingredientOrder", ObjectType.LIST);
            tx.insert(ingredients, 0, "ingredient-tomatoes");
            tx.insert(ingredients, 1, "ingredient-bread");

            ObjectId method = tx.set(recipe, "method", ObjectType.TEXT);
            tx.spliceText(method, 0, 0, "Chop onions and cook gently.");

            ObjectId chat = tx.set(ObjectId.ROOT, "chat", ObjectType.LIST);
            tx.insert(chat, 0, "seed-message");

            tx.set(ObjectId.ROOT, "allergies", ObjectType.MAP);
            ObjectId pantry = tx.set(ObjectId.ROOT, "pantry", ObjectType.MAP);

            ObjectId stepsById = tx.set(recipe, "stepsById", ObjectType.MAP);
            ObjectId step1 = tx.set(stepsById, "step-1", ObjectType.MAP);
            tx.set(step1, "text", "Chop onions.");
            ObjectId step2 = tx.set(stepsById, "step-2", ObjectType.MAP);
            tx.set(step2, "text", "Toast the bread.");
            ObjectId stepOrder = tx.set(recipe, "stepOrder", ObjectType.LIST);
            tx.insert(stepOrder, 0, "step-1");
            tx.insert(stepOrder, 1, "step-2");

            tx.set(pantry, "_schema", "stable-id-map");
            tx.commit();
        }
        return doc;
    }

    private static ObjectId map(org.automerge.Read doc, ObjectId parent, String key) {
        AmValue value = doc.get(parent, key).orElseThrow(() -> new AssertionError("missing map " + key));
        check(value instanceof AmValue.Map, key + " is not a map: " + value);
        return ((AmValue.Map) value).getId();
    }

    private static ObjectId list(org.automerge.Read doc, ObjectId parent, String key) {
        AmValue value = doc.get(parent, key).orElseThrow(() -> new AssertionError("missing list " + key));
        check(value instanceof AmValue.List, key + " is not a list: " + value);
        return ((AmValue.List) value).getId();
    }

    private static ObjectId text(org.automerge.Read doc, ObjectId parent, String key) {
        AmValue value = doc.get(parent, key).orElseThrow(() -> new AssertionError("missing text " + key));
        check(value instanceof AmValue.Text, key + " is not text: " + value);
        return ((AmValue.Text) value).getId();
    }

    private static String str(org.automerge.Read doc, ObjectId object, String key) {
        AmValue value = doc.get(object, key).orElseThrow(() -> new AssertionError("missing string " + key));
        check(value instanceof AmValue.Str, key + " not string: " + value);
        return ((AmValue.Str) value).getValue();
    }

    private static long integer(org.automerge.Read doc, ObjectId object, String key) {
        AmValue value = doc.get(object, key).orElseThrow(() -> new AssertionError("missing int " + key));
        check(value instanceof AmValue.Int, key + " not int: " + value);
        return ((AmValue.Int) value).getValue();
    }

    private static boolean bool(org.automerge.Read doc, ObjectId object, String key) {
        AmValue value = doc.get(object, key).orElseThrow(() -> new AssertionError("missing bool " + key));
        check(value instanceof AmValue.Bool, key + " not bool: " + value);
        return ((AmValue.Bool) value).getValue();
    }

    private static String listString(org.automerge.Read doc, ObjectId object, long index) {
        AmValue value = doc.get(object, index).orElseThrow(() -> new AssertionError("missing list index " + index));
        check(value instanceof AmValue.Str, "list value not string: " + value);
        return ((AmValue.Str) value).getValue();
    }

    private static List<String> listStrings(Document doc, ObjectId object) {
        ArrayList<String> out = new ArrayList<>();
        for (long i = 0; i < doc.length(object); i++) out.add(listString(doc, object, i));
        return out;
    }

    private static Set<Long> conflictingInts(org.automerge.Read doc, ObjectId object, String key) {
        Conflicts conflicts = doc.getAll(object, key).orElseThrow(() -> new AssertionError("missing conflicts for " + key));
        HashSet<Long> values = new HashSet<>();
        for (AmValue value : conflicts.values()) {
            check(value instanceof AmValue.Int, "conflict value is not int");
            values.add(((AmValue.Int) value).getValue());
        }
        return values;
    }

    private static Set<String> conflictingStrings(org.automerge.Read doc, ObjectId object, String key) {
        Conflicts conflicts = doc.getAll(object, key).orElseThrow(() -> new AssertionError("missing conflicts for " + key));
        HashSet<String> values = new HashSet<>();
        for (AmValue value : conflicts.values()) {
            check(value instanceof AmValue.Str, "conflict value is not string");
            values.add(((AmValue.Str) value).getValue());
        }
        return values;
    }

    private static Document fork(Document base, String device) {
        return base.fork(actor(device));
    }

    private static void setString(Document doc, ObjectId object, String key, String value) {
        try (Transaction tx = doc.startTransaction()) {
            tx.set(object, key, value);
            tx.commit();
        }
    }

    private static void setInt(Document doc, ObjectId object, String key, int value) {
        try (Transaction tx = doc.startTransaction()) {
            tx.set(object, key, value);
            tx.commit();
        }
    }

    private static Set<ChangeHash> heads(Document doc) {
        return new HashSet<>(Arrays.asList(doc.getHeads()));
    }

    private static void syncPair(Document a, Document b) {
        SyncState stateA = new SyncState();
        SyncState stateB = new SyncState();
        try {
            for (int round = 0; round < 50; round++) {
                boolean sent = false;
                Optional<byte[]> fromA = a.generateSyncMessage(stateA);
                if (fromA.isPresent()) {
                    b.receiveSyncMessage(stateB, fromA.get());
                    sent = true;
                }
                Optional<byte[]> fromB = b.generateSyncMessage(stateB);
                if (fromB.isPresent()) {
                    a.receiveSyncMessage(stateA, fromB.get());
                    sent = true;
                }
                if (!sent) return;
            }
            throw new AssertionError("sync protocol did not quiesce");
        } finally {
            stateA.free();
            stateB.free();
        }
    }

    private static ScenarioResult execute(int number, String name, Scenario scenario) {
        try {
            String detail = scenario.run();
            String status = detail != null && detail.startsWith("PARTIAL:") ? "PARTIAL" : "PASS";
            return new ScenarioResult(number, name, status, detail == null ? "" : detail);
        } catch (Throwable error) {
            return new ScenarioResult(number, name, "FAIL", error.toString());
        }
    }

    public static ScenarioSummary runAll() {
        ArrayList<ScenarioResult> results = new ArrayList<>();

        results.add(execute(1, "different recipe fields", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            ObjectId pRecipe = map(phone, ObjectId.ROOT, "recipe");
            ObjectId lRecipe = map(laptop, ObjectId.ROOT, "recipe");
            setString(phone, pRecipe, "title", "Phone title");
            setInt(laptop, lRecipe, "portions", 4);
            phone.merge(laptop);
            ObjectId merged = map(phone, ObjectId.ROOT, "recipe");
            check(str(phone, merged, "title").equals("Phone title"), "title lost");
            check(integer(phone, merged, "portions") == 4, "portions lost");
            base.free(); laptop.free(); phone.free();
            return "compatible fields survive";
        }));

        results.add(execute(2, "same nested entity, different properties", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            ObjectId pIngredient = map(phone, map(phone, ObjectId.ROOT, "recipe"), "ingredient");
            ObjectId lIngredient = map(laptop, map(laptop, ObjectId.ROOT, "recipe"), "ingredient");
            setString(phone, pIngredient, "amount", "3");
            setString(laptop, lIngredient, "name", "tomatoes (ripe)");
            phone.merge(laptop);
            ObjectId ingredient = map(phone, map(phone, ObjectId.ROOT, "recipe"), "ingredient");
            check(str(phone, ingredient, "amount").equals("3"), "amount lost");
            check(str(phone, ingredient, "name").equals("tomatoes (ripe)"), "name lost");
            base.free(); laptop.free(); phone.free();
            return "nested fields survive";
        }));

        results.add(execute(3, "concurrent additions", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            try (Transaction tx = phone.startTransaction()) {
                ObjectId order = list(tx, map(tx, ObjectId.ROOT, "recipe"), "ingredientOrder");
                tx.insert(order, tx.length(order), "ingredient-basil");
                tx.commit();
            }
            try (Transaction tx = laptop.startTransaction()) {
                ObjectId order = list(tx, map(tx, ObjectId.ROOT, "recipe"), "ingredientOrder");
                tx.insert(order, tx.length(order), "ingredient-garlic");
                tx.commit();
            }
            Document reverse = laptop.fork(actor("reverse"));
            reverse.merge(phone);
            phone.merge(laptop);
            List<String> a = listStrings(phone, list(phone, map(phone, ObjectId.ROOT, "recipe"), "ingredientOrder"));
            List<String> b = listStrings(reverse, list(reverse, map(reverse, ObjectId.ROOT, "recipe"), "ingredientOrder"));
            check(a.contains("ingredient-basil") && a.contains("ingredient-garlic"), "addition lost");
            check(a.equals(b), "ordering differs by merge direction");
            base.free(); laptop.free(); reverse.free(); phone.free();
            return "deterministic merged order=" + a;
        }));

        results.add(execute(4, "concurrent text editing", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            try (Transaction tx = phone.startTransaction()) {
                ObjectId method = text(tx, map(tx, ObjectId.ROOT, "recipe"), "method");
                tx.spliceText(method, 11, 0, " finely");
                tx.commit();
            }
            try (Transaction tx = laptop.startTransaction()) {
                ObjectId method = text(tx, map(tx, ObjectId.ROOT, "recipe"), "method");
                tx.spliceText(method, tx.text(method).orElseThrow().length(), 0, " until golden");
                tx.commit();
            }
            phone.merge(laptop);
            ObjectId method = text(phone, map(phone, ObjectId.ROOT, "recipe"), "method");
            String merged = phone.text(method).orElseThrow();
            check(merged.contains("finely"), "phone text lost");
            check(merged.contains("until golden"), "laptop text lost");
            base.free(); laptop.free(); phone.free();
            return "exact text=" + merged;
        }));

        results.add(execute(5, "chat appends", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            try (Transaction tx = phone.startTransaction()) {
                ObjectId chat = list(tx, ObjectId.ROOT, "chat");
                tx.insert(chat, tx.length(chat), "phone-message");
                tx.commit();
            }
            try (Transaction tx = laptop.startTransaction()) {
                ObjectId chat = list(tx, ObjectId.ROOT, "chat");
                tx.insert(chat, tx.length(chat), "laptop-message");
                tx.commit();
            }
            phone.merge(laptop);
            List<String> values = listStrings(phone, list(phone, ObjectId.ROOT, "chat"));
            check(values.contains("phone-message") && values.contains("laptop-message"), "chat append lost");
            base.free(); laptop.free(); phone.free();
            return "messages=" + values;
        }));

        results.add(execute(6, "set-like additions", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            setString(phone, map(phone, ObjectId.ROOT, "allergies"), "peanuts", "present");
            setString(laptop, map(laptop, ObjectId.ROOT, "allergies"), "sesame", "present");
            phone.merge(laptop);
            ObjectId allergies = map(phone, ObjectId.ROOT, "allergies");
            check(str(phone, allergies, "peanuts").equals("present"), "peanuts lost");
            check(str(phone, allergies, "sesame").equals("present"), "sesame lost");
            base.free(); laptop.free(); phone.free();
            return "both set-like keys survive";
        }));

        results.add(execute(7, "same scalar disagreement", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            setInt(phone, map(phone, ObjectId.ROOT, "recipe"), "portions", 4);
            setInt(laptop, map(laptop, ObjectId.ROOT, "recipe"), "portions", 6);
            phone.merge(laptop);
            ObjectId recipe = map(phone, ObjectId.ROOT, "recipe");
            check(conflictingInts(phone, recipe, "portions").equals(Set.of(4L, 6L)), "both alternatives not retained");
            ChangeHash[] heads = phone.getHeads();
            setInt(phone, recipe, "portions", 5);
            check(conflictingInts(phone, recipe, "portions").equals(Set.of(5L)), "resolution did not supersede");
            check(heads.length == 2, "pre-resolution should have two heads");
            base.free(); laptop.free(); phone.free();
            return "PARTIAL: values and causal resolution are exposed, but Java 0.0.9 Conflicts drops op-id/source keys and exposes no change metadata API";
        }));

        results.add(execute(8, "same atomic title", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            setString(phone, map(phone, ObjectId.ROOT, "recipe"), "title", "Basil toast");
            setString(laptop, map(laptop, ObjectId.ROOT, "recipe"), "title", "Garlic toast");
            phone.merge(laptop);
            Set<String> values = conflictingStrings(phone, map(phone, ObjectId.ROOT, "recipe"), "title");
            check(values.equals(Set.of("Basil toast", "Garlic toast")), "title alternatives unavailable");
            base.free(); laptop.free(); phone.free();
            return "both titles can drive review";
        }));

        results.add(execute(9, "delete versus edit", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            try (Transaction tx = phone.startTransaction()) {
                ObjectId recipe = map(tx, ObjectId.ROOT, "recipe");
                tx.set(recipe, "deleted", true);
                tx.set(recipe, "deletedBy", "iphone");
                tx.commit();
            }
            setString(laptop, map(laptop, ObjectId.ROOT, "recipe"), "title", "Edited offline");
            phone.merge(laptop);
            ObjectId recipe = map(phone, ObjectId.ROOT, "recipe");
            check(bool(phone, recipe, "deleted"), "tombstone lost");
            check(str(phone, recipe, "title").equals("Edited offline"), "concurrent edit lost");
            base.free(); laptop.free(); phone.free();
            return "tombstone + edit coexist for semantic review";
        }));

        results.add(execute(10, "duplicate pantry item", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            try (Transaction tx = phone.startTransaction()) {
                ObjectId pantry = map(tx, ObjectId.ROOT, "pantry");
                ObjectId item = tx.set(pantry, "carrots-phone", ObjectType.MAP);
                tx.set(item, "normalizedName", "carrots");
                tx.set(item, "preference", 5);
                tx.commit();
            }
            try (Transaction tx = laptop.startTransaction()) {
                ObjectId pantry = map(tx, ObjectId.ROOT, "pantry");
                ObjectId item = tx.set(pantry, "carrots-laptop", ObjectType.MAP);
                tx.set(item, "normalizedName", "carrots");
                tx.set(item, "preference", 2);
                tx.commit();
            }
            phone.merge(laptop);
            ObjectId pantry = map(phone, ObjectId.ROOT, "pantry");
            ObjectId p = map(phone, pantry, "carrots-phone");
            ObjectId l = map(phone, pantry, "carrots-laptop");
            check(integer(phone, p, "preference") == 5 && integer(phone, l, "preference") == 2, "duplicate evidence lost");
            base.free(); laptop.free(); phone.free();
            return "structural CRDT keeps both stable IDs/preferences; application dedupe required";
        }));

        results.add(execute(11, "reorder plus edit", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            try (Transaction tx = phone.startTransaction()) {
                ObjectId recipe = map(tx, ObjectId.ROOT, "recipe");
                ObjectId order = list(tx, recipe, "stepOrder");
                tx.delete(order, 1);
                tx.insert(order, 0, "step-2");
                tx.commit();
            }
            try (Transaction tx = laptop.startTransaction()) {
                ObjectId recipe = map(tx, ObjectId.ROOT, "recipe");
                ObjectId steps = map(tx, recipe, "stepsById");
                ObjectId step2 = map(tx, steps, "step-2");
                tx.set(step2, "text", "Toast the bread until deeply golden.");
                tx.commit();
            }
            phone.merge(laptop);
            ObjectId recipe = map(phone, ObjectId.ROOT, "recipe");
            ObjectId order = list(phone, recipe, "stepOrder");
            ObjectId step2 = map(phone, map(phone, recipe, "stepsById"), "step-2");
            check(listString(phone, order, 0).equals("step-2"), "reorder lost");
            check(str(phone, step2, "text").contains("deeply golden"), "stable-ID edit lost");
            base.free(); laptop.free(); phone.free();
            return "stable-ID map + order list preserves both";
        }));

        results.add(execute(12, "restart", () -> {
            Document base = seed();
            setString(base, map(base, ObjectId.ROOT, "recipe"), "description", "before restart");
            byte[] bytes = base.save();
            base.free();
            Document restarted = Document.load(bytes);
            Document writable = restarted.fork(actor("ipad"));
            restarted.free();
            setString(writable, map(writable, ObjectId.ROOT, "recipe"), "title", "after restart");
            check(str(writable, map(writable, ObjectId.ROOT, "recipe"), "description").equals("before restart"), "persisted edit lost");
            check(str(writable, map(writable, ObjectId.ROOT, "recipe"), "title").equals("after restart"), "post restart edit failed");
            byte[] cycle = writable.save();
            for (int i = 0; i < 25; i++) {
                Document loaded = Document.load(cycle);
                cycle = loaded.save();
                loaded.free();
            }
            writable.free();
            return "save/load + 25 explicit free cycles succeeded";
        }));

        results.add(execute(13, "out-of-order delivery", () -> {
            Document base = seed();
            ChangeHash[] baseHeads = base.getHeads();
            Document source = fork(base, "iphone");
            setString(source, map(source, ObjectId.ROOT, "recipe"), "description", "first");
            ChangeHash[] firstHeads = source.getHeads();
            byte[] first = source.encodeChangesSince(baseHeads);
            setString(source, map(source, ObjectId.ROOT, "recipe"), "title", "second");
            byte[] second = source.encodeChangesSince(firstHeads);

            Document receiver = fork(base, "ipad");
            receiver.applyEncodedChanges(second);
            receiver.applyEncodedChanges(first);
            ObjectId recipe = map(receiver, ObjectId.ROOT, "recipe");
            check(str(receiver, recipe, "description").equals("first"), "first causal edit absent");
            check(str(receiver, recipe, "title").equals("second"), "buffered second edit absent");
            base.free(); source.free(); receiver.free();
            return "encoded change batches delivered dependency-last still converge";
        }));

        results.add(execute(14, "duplicate delivery", () -> {
            Document base = seed();
            ChangeHash[] heads = base.getHeads();
            Document source = fork(base, "iphone");
            setString(source, map(source, ObjectId.ROOT, "recipe"), "title", "duplicate safe");
            byte[] changes = source.encodeChangesSince(heads);
            Document receiver = fork(base, "ipad");
            receiver.applyEncodedChanges(changes);
            receiver.applyEncodedChanges(changes);
            check(str(receiver, map(receiver, ObjectId.ROOT, "recipe"), "title").equals("duplicate safe"), "duplicate changed outcome");
            base.free(); source.free(); receiver.free();
            return "duplicate encoded changes are idempotent";
        }));

        results.add(execute(15, "long offline divergence", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            setString(phone, map(phone, ObjectId.ROOT, "recipe"), "title", "phone offline");
            setString(phone, map(phone, ObjectId.ROOT, "recipe"), "description", "phone description");
            setInt(phone, map(phone, ObjectId.ROOT, "recipe"), "portions", 4);
            setString(laptop, map(laptop, ObjectId.ROOT, "recipe"), "deletedBy", "nobody");
            setString(laptop, map(laptop, ObjectId.ROOT, "recipe"), "description", "laptop description");
            setInt(laptop, map(laptop, ObjectId.ROOT, "recipe"), "portions", 6);
            phone.merge(laptop);
            ObjectId recipe = map(phone, ObjectId.ROOT, "recipe");
            check(str(phone, recipe, "title").equals("phone offline"), "independent field lost");
            check(conflictingInts(phone, recipe, "portions").equals(Set.of(4L, 6L)), "disagreement evidence lost");
            check(conflictingStrings(phone, recipe, "description").size() == 2, "description disagreement not retained");
            base.free(); laptop.free(); phone.free();
            return "eventual merge keeps clean edits plus disagreements";
        }));

        results.add(execute(16, "merge direction", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            setString(phone, map(phone, ObjectId.ROOT, "recipe"), "title", "A");
            setString(laptop, map(laptop, ObjectId.ROOT, "recipe"), "title", "B");
            Document ab = phone.fork(actor("ab"));
            Document ba = laptop.fork(actor("ba"));
            ab.merge(laptop);
            ba.merge(phone);
            Set<String> a = conflictingStrings(ab, map(ab, ObjectId.ROOT, "recipe"), "title");
            Set<String> b = conflictingStrings(ba, map(ba, ObjectId.ROOT, "recipe"), "title");
            check(a.equals(b) && a.equals(Set.of("A", "B")), "logical results differ");
            base.free(); phone.free(); laptop.free(); ab.free(); ba.free();
            return "equivalent conflict set in both merge directions";
        }));

        results.add(execute(17, "sync protocol", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            setString(phone, map(phone, ObjectId.ROOT, "recipe"), "title", "sync phone");
            setString(laptop, map(laptop, ObjectId.ROOT, "recipe"), "description", "sync laptop");
            syncPair(phone, laptop);
            check(str(phone, map(phone, ObjectId.ROOT, "recipe"), "title").equals("sync phone"), "phone missing own title");
            check(str(laptop, map(laptop, ObjectId.ROOT, "recipe"), "title").equals("sync phone"), "laptop missing phone title");
            check(str(phone, map(phone, ObjectId.ROOT, "recipe"), "description").equals("sync laptop"), "phone missing laptop description");
            check(heads(phone).equals(heads(laptop)), "converged heads differ");
            base.free(); phone.free(); laptop.free();
            return "actual Java binding SyncState/message APIs converge with live in-memory session state";
        }));

        results.add(execute(18, "three replicas", () -> {
            Document base = seed();
            Document phone = fork(base, "iphone");
            Document laptop = fork(base, "macbook");
            Document ipad = fork(base, "ipad");
            setString(phone, map(phone, ObjectId.ROOT, "recipe"), "title", "three");
            setString(laptop, map(laptop, ObjectId.ROOT, "recipe"), "description", "three replicas");
            setString(ipad, map(ipad, ObjectId.ROOT, "allergies"), "sesame", "present");
            syncPair(phone, laptop);
            syncPair(laptop, ipad);
            syncPair(ipad, phone);
            syncPair(phone, laptop);
            Set<ChangeHash> a = heads(phone), b = heads(laptop), c = heads(ipad);
            check(a.equals(b) && b.equals(c), "three replicas did not converge to equivalent heads");
            check(str(phone, map(phone, ObjectId.ROOT, "recipe"), "title").equals("three"), "phone missing title");
            check(str(ipad, map(ipad, ObjectId.ROOT, "recipe"), "description").equals("three replicas"), "ipad missing description");
            check(str(laptop, map(laptop, ObjectId.ROOT, "allergies"), "sesame").equals("present"), "laptop missing allergy");
            base.free(); phone.free(); laptop.free(); ipad.free();
            return "three native replicas converge";
        }));

        int pass = (int) results.stream().filter(r -> r.status().equals("PASS")).count();
        int partial = (int) results.stream().filter(r -> r.status().equals("PARTIAL")).count();
        int fail = (int) results.stream().filter(r -> r.status().equals("FAIL")).count();
        return new ScenarioSummary(pass, partial, fail, results);
    }

    private static String jsonEscape(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    public static String toJson(ScenarioSummary summary) {
        StringBuilder b = new StringBuilder();
        b.append("{\"engine\":\"automerge-java\",\"version\":\"0.0.9\",\"summary\":{");
        b.append("\"pass\":").append(summary.pass()).append(",\"partial\":").append(summary.partial()).append(",\"fail\":").append(summary.fail()).append("},\"results\":[");
        for (int i = 0; i < summary.results().size(); i++) {
            if (i > 0) b.append(",");
            ScenarioResult r = summary.results().get(i);
            b.append("{\"number\":").append(r.number())
             .append(",\"name\":").append(jsonEscape(r.name()))
             .append(",\"status\":").append(jsonEscape(r.status()))
             .append(",\"detail\":").append(jsonEscape(r.detail())).append("}");
        }
        b.append("]}");
        return b.toString();
    }

    private static SyncState loadState(Path path) throws IOException {
        if (Files.exists(path) && Files.size(path) > 0) return SyncState.decode(Files.readAllBytes(path));
        return new SyncState();
    }

    private static Document loadWritable(Path path, String actorName) throws IOException {
        Document loaded = Document.load(Files.readAllBytes(path));
        Document writable = loaded.fork(actor(actorName));
        loaded.free();
        return writable;
    }

    private static void mutateInterop(Path input, Path output, String label, boolean concurrent) throws IOException {
        Document doc = loadWritable(input, concurrent ? "native-concurrent" : "native-sequential");
        try {
            ObjectId interop = map(doc, ObjectId.ROOT, "interop");
            try (Transaction tx = doc.startTransaction()) {
                if (concurrent) tx.set(interop, "nativeConcurrent", "native-edit-survived");
                else tx.set(interop, "nativeModified", label);
                tx.commit();
            }
            Files.write(output, doc.save());
        } finally {
            doc.free();
        }
    }

    private static void syncGenerate(Path docPath, Path statePath, Path messagePath) throws IOException {
        Document doc = Document.load(Files.readAllBytes(docPath));
        SyncState state = loadState(statePath);
        try {
            Optional<byte[]> message = doc.generateSyncMessage(state);
            Files.write(statePath, state.encode());
            Files.write(messagePath, message.orElseGet(() -> new byte[0]));
        } finally {
            state.free();
            doc.free();
        }
    }

    private static void syncReceive(Path docPath, Path statePath, Path messagePath) throws IOException {
        Document doc = Document.load(Files.readAllBytes(docPath));
        SyncState state = loadState(statePath);
        try {
            byte[] message = Files.readAllBytes(messagePath);
            if (message.length > 0) doc.receiveSyncMessage(state, message);
            Files.write(docPath, doc.save());
            Files.write(statePath, state.encode());
        } finally {
            state.free();
            doc.free();
        }
    }

    private static String peerCommand(BufferedReader reader, BufferedWriter writer, String command) throws IOException {
        writer.write(command);
        writer.newLine();
        writer.flush();
        String line = reader.readLine();
        if (line == null) throw new IOException("web peer exited while handling " + command);
        return line;
    }

    private static void liveSyncWeb(Path nativeDocPath, Path webDocPath, Path nativeOut, Path webOut, String peerScript)
            throws Exception {
        Document doc = Document.load(Files.readAllBytes(nativeDocPath));
        SyncState state = new SyncState();
        Process peer = new ProcessBuilder("node", peerScript, webDocPath.toString())
                .redirectError(ProcessBuilder.Redirect.INHERIT)
                .start();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(peer.getInputStream()));
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(peer.getOutputStream()))) {
            int messages = 0;
            int rounds = 0;
            for (; rounds < 50; rounds++) {
                boolean sent = false;

                String fromWeb = peerCommand(reader, writer, "GEN");
                check(fromWeb.startsWith("MSG "), "unexpected web peer response " + fromWeb);
                String encodedWeb = fromWeb.substring(4);
                if (!encodedWeb.equals("-")) {
                    doc.receiveSyncMessage(state, Base64.getDecoder().decode(encodedWeb));
                    messages++;
                    sent = true;
                }

                Optional<byte[]> fromNative = doc.generateSyncMessage(state);
                String encodedNative = fromNative
                        .map(bytes -> Base64.getEncoder().encodeToString(bytes))
                        .orElse("-");
                String received = peerCommand(reader, writer, "RECV " + encodedNative);
                check(received.equals("OK"), "unexpected web receive response " + received);
                if (fromNative.isPresent()) {
                    messages++;
                    sent = true;
                }

                if (!sent) break;
            }
            check(rounds < 50, "cross-language sync did not quiesce");

            String webDoc = peerCommand(reader, writer, "DOC");
            check(webDoc.startsWith("DOC "), "unexpected web doc response " + webDoc);
            Files.write(webOut, Base64.getDecoder().decode(webDoc.substring(4)));
            Files.write(nativeOut, doc.save());
            String bye = peerCommand(reader, writer, "QUIT");
            check(bye.equals("BYE"), "unexpected web peer shutdown " + bye);
            int exit = peer.waitFor();
            check(exit == 0, "web peer exited " + exit);
            System.out.println("{\"command\":\"live-sync-web\",\"native\":\"java-0.0.9\",\"messages\":" +
                    messages + ",\"rounds\":" + (rounds + 1) + "}");
        } finally {
            if (peer.isAlive()) peer.destroyForcibly();
            state.free();
            doc.free();
        }
    }

    private static void verifyAuthored(Path path) throws IOException {
        Document doc = Document.load(Files.readAllBytes(path));
        try {
            check(bool(doc, map(doc, ObjectId.ROOT, "interop"), "webCreated"), "authored JS doc did not load");
        } finally {
            doc.free();
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0 || args[0].equals("scenarios")) {
            ScenarioSummary summary = runAll();
            String json = toJson(summary);
            if (args.length >= 2) {
                Path out = Path.of(args[1]);
                Files.createDirectories(out.getParent());
                Files.writeString(out, json + System.lineSeparator());
            }
            System.out.println(json);
            if (summary.fail() > 0) System.exit(1);
            return;
        }

        switch (args[0]) {
            case "mutate" -> mutateInterop(Path.of(args[1]), Path.of(args[2]), args[3], false);
            case "fork-edit" -> mutateInterop(Path.of(args[1]), Path.of(args[2]), "native", true);
            case "sync-generate" -> syncGenerate(Path.of(args[1]), Path.of(args[2]), Path.of(args[3]));
            case "sync-receive" -> syncReceive(Path.of(args[1]), Path.of(args[2]), Path.of(args[3]));
            case "verify-authored" -> verifyAuthored(Path.of(args[1]));
            case "live-sync-web" -> liveSyncWeb(
                    Path.of(args[1]), Path.of(args[2]), Path.of(args[3]), Path.of(args[4]), args[5]);
            default -> throw new IllegalArgumentException("unknown command " + args[0]);
        }
    }
}
