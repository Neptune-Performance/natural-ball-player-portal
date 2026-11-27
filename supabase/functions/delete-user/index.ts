import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify caller identity
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Only admins can delete users
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: caller, error: roleError } = await serviceClient
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();

    if (roleError || !caller || caller.role !== "admin") {
      return new Response(
        JSON.stringify({ error: "Unauthorized: admin only" }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(
        JSON.stringify({ error: "Missing user_id" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Prevent self-deletion
    if (user_id === user.id) {
      return new Response(
        JSON.stringify({ error: "Cannot delete your own account" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Delete auth user first. If this fails the public row is still intact
    // and the operation can be retried safely. The reverse order (public
    // first) risks an orphaned auth row that permanently blocks email reuse.
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(user_id);
    if (deleteError) {
      // #501: when a database constraint stops the delete, GoTrue answers with
      // an empty body and supabase-js turns that into the message "{}", which
      // is what the admin saw ("Error deleting user: {}"). Log the real thing
      // and send back a sentence a person can act on.
      console.error("delete-user: auth delete failed", user_id, deleteError);
      const raw = String(deleteError.message || "").trim();
      const message = raw && raw !== "{}" && raw !== "[object Object]"
        ? raw
        : "The database refused to delete this account because other records still depend on it. Nothing was deleted.";
      return new Response(
        JSON.stringify({ error: message }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Then delete public.users row (cascades to child tables via FK rules).
    // If this fails, the auth row is already gone — surface the error but the
    // email is still reusable since auth was the gating constraint.
    const { error: dbError } = await serviceClient
      .from("users")
      .delete()
      .eq("id", user_id);
    if (dbError) {
      return new Response(
        JSON.stringify({
          error: "Auth user deleted but public.users delete failed: " + dbError.message,
          partial: true,
        }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
