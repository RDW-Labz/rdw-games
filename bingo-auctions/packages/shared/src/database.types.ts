export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      _schema_migrations: {
        Row: {
          applied_at: string
          applied_by: string | null
          checksum: string | null
          duration_ms: number | null
          filename: string
        }
        Insert: {
          applied_at?: string
          applied_by?: string | null
          checksum?: string | null
          duration_ms?: number | null
          filename: string
        }
        Update: {
          applied_at?: string
          applied_by?: string | null
          checksum?: string | null
          duration_ms?: number | null
          filename?: string
        }
        Relationships: []
      }
      ai_calls: {
        Row: {
          cached: boolean
          cost_cents: number
          created_at: string
          escalation_tier: number
          id: string
          input_tokens: number
          latency_ms: number
          lot_id: string | null
          model: string | null
          operator_id: string
          output_tokens: number
          task: string
          user_id: string
        }
        Insert: {
          cached?: boolean
          cost_cents?: number
          created_at?: string
          escalation_tier?: number
          id?: string
          input_tokens?: number
          latency_ms?: number
          lot_id?: string | null
          model?: string | null
          operator_id: string
          output_tokens?: number
          task: string
          user_id: string
        }
        Update: {
          cached?: boolean
          cost_cents?: number
          created_at?: string
          escalation_tier?: number
          id?: string
          input_tokens?: number
          latency_ms?: number
          lot_id?: string | null
          model?: string | null
          operator_id?: string
          output_tokens?: number
          task?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_calls_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_calls_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "ai_calls_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_calls_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      auction_status_history: {
        Row: {
          auction_id: string
          changed_at: string
          changed_by: string | null
          context: Json
          from_status: string | null
          id: number
          to_status: string
        }
        Insert: {
          auction_id: string
          changed_at?: string
          changed_by?: string | null
          context?: Json
          from_status?: string | null
          id?: number
          to_status: string
        }
        Update: {
          auction_id?: string
          changed_at?: string
          changed_by?: string | null
          context?: Json
          from_status?: string | null
          id?: number
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "auction_status_history_auction_id_fkey"
            columns: ["auction_id"]
            isOneToOne: false
            referencedRelation: "auctions"
            referencedColumns: ["id"]
          },
        ]
      }
      auctions: {
        Row: {
          bid_increment_schedule: Json | null
          /**
           * 0451: 'standard' (default) or 'per_unit'. Stored amounts are
           * always the total pallet price in cents either way.
           */
          bid_mode: string
          buyer_premium_bps: number
          canceled_at: string | null
          canceled_by: string | null
          close_stagger_seconds: number
          closed_at: string | null
          created_at: string
          description: string | null
          ends_at: string
          featured_image_urls: string[]
          format: Database["public"]["Enums"]["auction_format"]
          id: string
          last_lot_ends_at: string | null
          operator_id: string
          pickup_ends_at: string
          pickup_mode_override: string | null
          pickup_starts_at: string
          soft_close_minutes: number
          starts_at: string
          status: Database["public"]["Enums"]["auction_status"]
          title: string
          /**
           * 0451: per_unit auctions only — default starting price per unit,
           * in cents (e.g. 10 = $0.10/sq ft). A lot's own starting_bid_cents
           * overrides it. NULL for every standard auction.
           */
          unit_start_cents: number | null
          updated_at: string
          warehouse_id: string
        }
        Insert: {
          bid_increment_schedule?: Json | null
          bid_mode?: string
          buyer_premium_bps?: number
          canceled_at?: string | null
          canceled_by?: string | null
          close_stagger_seconds?: number
          closed_at?: string | null
          created_at?: string
          description?: string | null
          ends_at: string
          featured_image_urls?: string[]
          format?: Database["public"]["Enums"]["auction_format"]
          id?: string
          last_lot_ends_at?: string | null
          operator_id: string
          pickup_ends_at: string
          pickup_mode_override?: string | null
          pickup_starts_at: string
          soft_close_minutes?: number
          starts_at: string
          status?: Database["public"]["Enums"]["auction_status"]
          title: string
          unit_start_cents?: number | null
          updated_at?: string
          warehouse_id: string
        }
        Update: {
          bid_increment_schedule?: Json | null
          bid_mode?: string
          buyer_premium_bps?: number
          canceled_at?: string | null
          canceled_by?: string | null
          close_stagger_seconds?: number
          closed_at?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string
          featured_image_urls?: string[]
          format?: Database["public"]["Enums"]["auction_format"]
          id?: string
          last_lot_ends_at?: string | null
          operator_id?: string
          pickup_ends_at?: string
          pickup_mode_override?: string | null
          pickup_starts_at?: string
          soft_close_minutes?: number
          starts_at?: string
          status?: Database["public"]["Enums"]["auction_status"]
          title?: string
          unit_start_cents?: number | null
          updated_at?: string
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "auctions_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "auctions_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auctions_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auctions_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "walk_progress_per_warehouse"
            referencedColumns: ["warehouse_id"]
          },
          {
            foreignKeyName: "auctions_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      auto_charge_jobs: {
        Row: {
          attempt_count: number
          bidder_id: string
          created_at: string
          invoice_id: string
          last_error: string | null
          next_attempt_at: string
        }
        Insert: {
          attempt_count?: number
          bidder_id: string
          created_at?: string
          invoice_id: string
          last_error?: string | null
          next_attempt_at?: string
        }
        Update: {
          attempt_count?: number
          bidder_id?: string
          created_at?: string
          invoice_id?: string
          last_error?: string | null
          next_attempt_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "auto_charge_jobs_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auto_charge_jobs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      bidder_fee_ledger: {
        Row: {
          amount_cents: number
          bidder_id: string
          created_at: string
          id: string
          invoice_id: string | null
          paid_at: string | null
          paid_payment_intent_id: string | null
          reason: string
        }
        Insert: {
          amount_cents: number
          bidder_id: string
          created_at?: string
          id?: string
          invoice_id?: string | null
          paid_at?: string | null
          paid_payment_intent_id?: string | null
          reason: string
        }
        Update: {
          amount_cents?: number
          bidder_id?: string
          created_at?: string
          id?: string
          invoice_id?: string | null
          paid_at?: string | null
          paid_payment_intent_id?: string | null
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "bidder_fee_ledger_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bidder_fee_ledger_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      bidder_sticker_scan_log: {
        Row: {
          bidder_id: string
          scanned_at: string
        }
        Insert: {
          bidder_id: string
          scanned_at?: string
        }
        Update: {
          bidder_id?: string
          scanned_at?: string
        }
        Relationships: []
      }
      bidder_subscriptions: {
        Row: {
          bidder_id: string
          created_at: string
          current_period_end: string | null
          id: string
          operator_id: string
          plan_id: string | null
          status: Database["public"]["Enums"]["subscription_status"]
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          bidder_id: string
          created_at?: string
          current_period_end?: string | null
          id?: string
          operator_id: string
          plan_id?: string | null
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          bidder_id?: string
          created_at?: string
          current_period_end?: string | null
          id?: string
          operator_id?: string
          plan_id?: string | null
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bidder_subscriptions_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bidder_subscriptions_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "bidder_subscriptions_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bidder_subscriptions_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bidder_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "operator_pro_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      bidders: {
        Row: {
          birth_date: string | null
          card_brand: string | null
          card_exp_month: number | null
          card_exp_year: number | null
          card_last4: string | null
          created_at: string
          default_payment_method_id: string | null
          deleted_at: string | null
          display_name: string | null
          email: string
          email_enabled: boolean
          expo_push_token: string | null
          id: string
          identity_verified_at: string | null
          is_reviewer: boolean
          no_show_count: number
          phone: string | null
          postal_code: string | null
          postal_code_prompt_after: string | null
          postal_code_prompt_count: number
          postal_code_updated_at: string | null
          preview_operator_id: string | null
          push_enabled: boolean
          push_registered_at: string | null
          sms_enabled: boolean
          square_customer_id: string | null
          stripe_customer_id: string | null
          stripe_key_mode: string | null
          stripe_subscription_id: string | null
          subscription_expires_at: string | null
          subscription_status: Database["public"]["Enums"]["subscription_status"]
          total_lifetime_wins: number
          unpaid_fees_cents: number
          updated_at: string
        }
        Insert: {
          birth_date?: string | null
          card_brand?: string | null
          card_exp_month?: number | null
          card_exp_year?: number | null
          card_last4?: string | null
          created_at?: string
          default_payment_method_id?: string | null
          deleted_at?: string | null
          display_name?: string | null
          email: string
          email_enabled?: boolean
          expo_push_token?: string | null
          id: string
          identity_verified_at?: string | null
          is_reviewer?: boolean
          no_show_count?: number
          phone?: string | null
          postal_code?: string | null
          postal_code_prompt_after?: string | null
          postal_code_prompt_count?: number
          postal_code_updated_at?: string | null
          preview_operator_id?: string | null
          push_enabled?: boolean
          push_registered_at?: string | null
          sms_enabled?: boolean
          square_customer_id?: string | null
          stripe_customer_id?: string | null
          stripe_key_mode?: string | null
          stripe_subscription_id?: string | null
          subscription_expires_at?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          total_lifetime_wins?: number
          unpaid_fees_cents?: number
          updated_at?: string
        }
        Update: {
          birth_date?: string | null
          card_brand?: string | null
          card_exp_month?: number | null
          card_exp_year?: number | null
          card_last4?: string | null
          created_at?: string
          default_payment_method_id?: string | null
          deleted_at?: string | null
          display_name?: string | null
          email?: string
          email_enabled?: boolean
          expo_push_token?: string | null
          id?: string
          identity_verified_at?: string | null
          is_reviewer?: boolean
          no_show_count?: number
          phone?: string | null
          postal_code?: string | null
          postal_code_prompt_after?: string | null
          postal_code_prompt_count?: number
          postal_code_updated_at?: string | null
          preview_operator_id?: string | null
          push_enabled?: boolean
          push_registered_at?: string | null
          sms_enabled?: boolean
          square_customer_id?: string | null
          stripe_customer_id?: string | null
          stripe_key_mode?: string | null
          stripe_subscription_id?: string | null
          subscription_expires_at?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          total_lifetime_wins?: number
          unpaid_fees_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bidders_preview_operator_id_fkey"
            columns: ["preview_operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "bidders_preview_operator_id_fkey"
            columns: ["preview_operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bidders_preview_operator_id_fkey"
            columns: ["preview_operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      bids: {
        Row: {
          amount_cents: number
          bidder_id: string
          id: string
          is_auto: boolean
          lot_id: string
          max_amount_cents: number
          placed_at: string
        }
        Insert: {
          amount_cents: number
          bidder_id: string
          id?: string
          is_auto?: boolean
          lot_id: string
          max_amount_cents: number
          placed_at?: string
        }
        Update: {
          amount_cents?: number
          bidder_id?: string
          id?: string
          is_auto?: boolean
          lot_id?: string
          max_amount_cents?: number
          placed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bids_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bids_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
        ]
      }
      bin_assignments: {
        Row: {
          assigned_at: string
          bin_id: string
          id: string
          lot_id: string
          notes: string | null
          operator_user_id: string | null
          picked_up_at: string | null
          staging_photo_url: string | null
          status: Database["public"]["Enums"]["bin_assignment_status"]
        }
        Insert: {
          assigned_at?: string
          bin_id: string
          id?: string
          lot_id: string
          notes?: string | null
          operator_user_id?: string | null
          picked_up_at?: string | null
          staging_photo_url?: string | null
          status?: Database["public"]["Enums"]["bin_assignment_status"]
        }
        Update: {
          assigned_at?: string
          bin_id?: string
          id?: string
          lot_id?: string
          notes?: string | null
          operator_user_id?: string | null
          picked_up_at?: string | null
          staging_photo_url?: string | null
          status?: Database["public"]["Enums"]["bin_assignment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "bin_assignments_bin_id_fkey"
            columns: ["bin_id"]
            isOneToOne: false
            referencedRelation: "bins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bin_assignments_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bin_assignments_operator_user_id_fkey"
            columns: ["operator_user_id"]
            isOneToOne: false
            referencedRelation: "operator_users"
            referencedColumns: ["id"]
          },
        ]
      }
      bins: {
        Row: {
          aisle: string
          bay: string | null
          code: string
          coord_x_m: number | null
          coord_y_m: number | null
          created_at: string
          floor_plan_version_placed: number | null
          id: string
          is_active: boolean
          landmark_photo_taken_at: string | null
          landmark_photo_url: string | null
          level: number | null
          position: number | null
          qr_revoked_at: string | null
          qr_revoked_by: string | null
          qr_revoked_reason: string | null
          qr_rotated_at: string | null
          qr_token: string
          retired_at: string | null
          scan_pose: Json | null
          scanned_at: string | null
          section: string | null
          updated_at: string
          warehouse_id: string
          x_px: number
          y_px: number
        }
        Insert: {
          aisle: string
          bay?: string | null
          code: string
          coord_x_m?: number | null
          coord_y_m?: number | null
          created_at?: string
          floor_plan_version_placed?: number | null
          id?: string
          is_active?: boolean
          landmark_photo_taken_at?: string | null
          landmark_photo_url?: string | null
          level?: number | null
          position?: number | null
          qr_revoked_at?: string | null
          qr_revoked_by?: string | null
          qr_revoked_reason?: string | null
          qr_rotated_at?: string | null
          qr_token?: string
          retired_at?: string | null
          scan_pose?: Json | null
          scanned_at?: string | null
          section?: string | null
          updated_at?: string
          warehouse_id: string
          x_px: number
          y_px: number
        }
        Update: {
          aisle?: string
          bay?: string | null
          code?: string
          coord_x_m?: number | null
          coord_y_m?: number | null
          created_at?: string
          floor_plan_version_placed?: number | null
          id?: string
          is_active?: boolean
          landmark_photo_taken_at?: string | null
          landmark_photo_url?: string | null
          level?: number | null
          position?: number | null
          qr_revoked_at?: string | null
          qr_revoked_by?: string | null
          qr_revoked_reason?: string | null
          qr_rotated_at?: string | null
          qr_token?: string
          retired_at?: string | null
          scan_pose?: Json | null
          scanned_at?: string | null
          section?: string | null
          updated_at?: string
          warehouse_id?: string
          x_px?: number
          y_px?: number
        }
        Relationships: [
          {
            foreignKeyName: "bins_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "walk_progress_per_warehouse"
            referencedColumns: ["warehouse_id"]
          },
          {
            foreignKeyName: "bins_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      brand_aliases: {
        Row: {
          alias: string
          alias_length: number | null
          canonical: string
        }
        Insert: {
          alias: string
          alias_length?: number | null
          canonical: string
        }
        Update: {
          alias?: string
          alias_length?: number | null
          canonical?: string
        }
        Relationships: []
      }
      build_invoice_jobs: {
        Row: {
          attempt_count: number
          auction_id: string
          last_attempt_at: string | null
          last_error: string | null
          run_at: string
        }
        Insert: {
          attempt_count?: number
          auction_id: string
          last_attempt_at?: string | null
          last_error?: string | null
          run_at: string
        }
        Update: {
          attempt_count?: number
          auction_id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          run_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "build_invoice_jobs_auction_id_fkey"
            columns: ["auction_id"]
            isOneToOne: true
            referencedRelation: "auctions"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          created_at: string
          icon: string | null
          icon_url: string | null
          id: string
          image_url: string | null
          image_url_clean: string | null
          name: string
          pack_slug: string | null
          parent_id: string | null
          slug: string
          sort_order: number
          square_url: string | null
        }
        Insert: {
          created_at?: string
          icon?: string | null
          icon_url?: string | null
          id?: string
          image_url?: string | null
          image_url_clean?: string | null
          name: string
          pack_slug?: string | null
          parent_id?: string | null
          slug: string
          sort_order?: number
          square_url?: string | null
        }
        Update: {
          created_at?: string
          icon?: string | null
          icon_url?: string | null
          id?: string
          image_url?: string | null
          image_url_clean?: string | null
          name?: string
          pack_slug?: string | null
          parent_id?: string | null
          slug?: string
          sort_order?: number
          square_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      category_aliases: {
        Row: {
          category_id: string
          confidence: number | null
          created_at: string
          raw: string
          source: string | null
        }
        Insert: {
          category_id: string
          confidence?: number | null
          created_at?: string
          raw: string
          source?: string | null
        }
        Update: {
          category_id?: string
          confidence?: number | null
          created_at?: string
          raw?: string
          source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "category_aliases_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      competitor_lots: {
        Row: {
          bid_count: number | null
          brand: string | null
          category_id: string | null
          category_raw: string | null
          closes_at: string | null
          condition: string | null
          created_at: string
          current_bid_cents: number | null
          description: string | null
          discount_pct: number | null
          final_bid_cents: number | null
          first_seen_at: string
          image_urls: string[]
          last_seen_at: string
          location: string | null
          model: string | null
          msrp_cents: number | null
          raw_json: Json | null
          source: string
          source_id: string
          state: string | null
          title: string
          upc: string | null
          updated_at: string
          url: string
        }
        Insert: {
          bid_count?: number | null
          brand?: string | null
          category_id?: string | null
          category_raw?: string | null
          closes_at?: string | null
          condition?: string | null
          created_at?: string
          current_bid_cents?: number | null
          description?: string | null
          discount_pct?: number | null
          final_bid_cents?: number | null
          first_seen_at: string
          image_urls?: string[]
          last_seen_at: string
          location?: string | null
          model?: string | null
          msrp_cents?: number | null
          raw_json?: Json | null
          source: string
          source_id: string
          state?: string | null
          title: string
          upc?: string | null
          updated_at?: string
          url: string
        }
        Update: {
          bid_count?: number | null
          brand?: string | null
          category_id?: string | null
          category_raw?: string | null
          closes_at?: string | null
          condition?: string | null
          created_at?: string
          current_bid_cents?: number | null
          description?: string | null
          discount_pct?: number | null
          final_bid_cents?: number | null
          first_seen_at?: string
          image_urls?: string[]
          last_seen_at?: string
          location?: string | null
          model?: string | null
          msrp_cents?: number | null
          raw_json?: Json | null
          source?: string
          source_id?: string
          state?: string | null
          title?: string
          upc?: string | null
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitor_lots_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      disputes: {
        Row: {
          bidder_id: string
          bidder_photo_urls: string[]
          created_at: string
          id: string
          invoice_id: string
          lot_id: string
          operator_id: string
          reason: string
          refund_cents: number
          resolution_notes: string | null
          resolved_at: string | null
          status: Database["public"]["Enums"]["dispute_status"]
        }
        Insert: {
          bidder_id: string
          bidder_photo_urls?: string[]
          created_at?: string
          id?: string
          invoice_id: string
          lot_id: string
          operator_id: string
          reason: string
          refund_cents?: number
          resolution_notes?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
        }
        Update: {
          bidder_id?: string
          bidder_photo_urls?: string[]
          created_at?: string
          id?: string
          invoice_id?: string
          lot_id?: string
          operator_id?: string
          reason?: string
          refund_cents?: number
          resolution_notes?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
        }
        Relationships: [
          {
            foreignKeyName: "disputes_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "disputes_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      image_enrichment_jobs: {
        Row: {
          attempts: number
          enqueued_at: string
          error: string | null
          id: string
          identifier_kind: string | null
          identifier_value: string | null
          operator_id: string
          processed_at: string | null
          resolved_image_url: string | null
          status: string
          target_id: string
          target_table: string
        }
        Insert: {
          attempts?: number
          enqueued_at?: string
          error?: string | null
          id?: string
          identifier_kind?: string | null
          identifier_value?: string | null
          operator_id: string
          processed_at?: string | null
          resolved_image_url?: string | null
          status?: string
          target_id: string
          target_table: string
        }
        Update: {
          attempts?: number
          enqueued_at?: string
          error?: string | null
          id?: string
          identifier_kind?: string | null
          identifier_value?: string | null
          operator_id?: string
          processed_at?: string | null
          resolved_image_url?: string | null
          status?: string
          target_id?: string
          target_table?: string
        }
        Relationships: [
          {
            foreignKeyName: "image_enrichment_jobs_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "image_enrichment_jobs_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "image_enrichment_jobs_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      import_rows: {
        Row: {
          asin: string | null
          brand: string | null
          catalog_id: string | null
          category_id: string | null
          category_raw: string | null
          condition: string | null
          cost_cents: number | null
          created_at: string
          description: string | null
          dropped_at: string | null
          dropped_by: string | null
          dropped_reason: string | null
          external_code: string | null
          fnsku: string | null
          id: string
          import_id: string
          lot_id: string | null
          lotted_at: string | null
          lpn: string | null
          manufacture_sku: string | null
          model: string | null
          msrp_cents: number | null
          operator_id: string
          order_id: string | null
          pallet_id: string | null
          photo_url: string | null
          po_number: string | null
          product_sku: string | null
          quantity: number
          raw_data: Json
          return_carrier: string | null
          return_initiated_at: string | null
          return_reason: string | null
          site_sku: string | null
          sku_active: boolean | null
          starting_bid_cents: number | null
          status: string
          sub_category_raw: string | null
          title: string
          tracking_number: string | null
          upc: string | null
          updated_at: string
          warehouse_id: string | null
        }
        Insert: {
          asin?: string | null
          brand?: string | null
          catalog_id?: string | null
          category_id?: string | null
          category_raw?: string | null
          condition?: string | null
          cost_cents?: number | null
          created_at?: string
          description?: string | null
          dropped_at?: string | null
          dropped_by?: string | null
          dropped_reason?: string | null
          external_code?: string | null
          fnsku?: string | null
          id?: string
          import_id: string
          lot_id?: string | null
          lotted_at?: string | null
          lpn?: string | null
          manufacture_sku?: string | null
          model?: string | null
          msrp_cents?: number | null
          operator_id: string
          order_id?: string | null
          pallet_id?: string | null
          photo_url?: string | null
          po_number?: string | null
          product_sku?: string | null
          quantity?: number
          raw_data?: Json
          return_carrier?: string | null
          return_initiated_at?: string | null
          return_reason?: string | null
          site_sku?: string | null
          sku_active?: boolean | null
          starting_bid_cents?: number | null
          status?: string
          sub_category_raw?: string | null
          title: string
          tracking_number?: string | null
          upc?: string | null
          updated_at?: string
          warehouse_id?: string | null
        }
        Update: {
          asin?: string | null
          brand?: string | null
          catalog_id?: string | null
          category_id?: string | null
          category_raw?: string | null
          condition?: string | null
          cost_cents?: number | null
          created_at?: string
          description?: string | null
          dropped_at?: string | null
          dropped_by?: string | null
          dropped_reason?: string | null
          external_code?: string | null
          fnsku?: string | null
          id?: string
          import_id?: string
          lot_id?: string | null
          lotted_at?: string | null
          lpn?: string | null
          manufacture_sku?: string | null
          model?: string | null
          msrp_cents?: number | null
          operator_id?: string
          order_id?: string | null
          pallet_id?: string | null
          photo_url?: string | null
          po_number?: string | null
          product_sku?: string | null
          quantity?: number
          raw_data?: Json
          return_carrier?: string | null
          return_initiated_at?: string | null
          return_reason?: string | null
          site_sku?: string | null
          sku_active?: boolean | null
          starting_bid_cents?: number | null
          status?: string
          sub_category_raw?: string | null
          title?: string
          tracking_number?: string | null
          upc?: string | null
          updated_at?: string
          warehouse_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "import_rows_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "import_rows_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "walk_progress_per_warehouse"
            referencedColumns: ["warehouse_id"]
          },
          {
            foreignKeyName: "import_rows_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      imports: {
        Row: {
          classified_count: number
          created_at: string
          created_by: string | null
          error: string | null
          filename: string
          id: string
          mapping: Json
          operator_id: string
          row_count: number
          source_label: string | null
          status: string
        }
        Insert: {
          classified_count?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          filename: string
          id?: string
          mapping?: Json
          operator_id: string
          row_count?: number
          source_label?: string | null
          status?: string
        }
        Update: {
          classified_count?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          filename?: string
          id?: string
          mapping?: Json
          operator_id?: string
          row_count?: number
          source_label?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "imports_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "imports_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "imports_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_lots: {
        Row: {
          invoice_id: string
          lot_id: string
          winning_bid_cents: number
        }
        Insert: {
          invoice_id: string
          lot_id: string
          winning_bid_cents: number
        }
        Update: {
          invoice_id?: string
          lot_id?: string
          winning_bid_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lots_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lots_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_status_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          context: Json
          from_status: string | null
          id: number
          invoice_id: string
          to_status: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          context?: Json
          from_status?: string | null
          id?: number
          invoice_id: string
          to_status: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          context?: Json
          from_status?: string | null
          id?: number
          invoice_id?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_status_history_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          application_fee_cents: number
          auction_id: string
          authentication_client_secret: string | null
          authentication_required_at: string | null
          auto_charge_attempt_count: number
          bidder_id: string
          buyer_premium_cents: number
          created_at: string
          delivered_at: string | null
          dispute_id: string | null
          dispute_reason: string | null
          dispute_status: string | null
          disputed_at: string | null
          easypost_rate_id: string | null
          easypost_shipment_id: string | null
          evidence_due_by: string | null
          fulfillment_method:
            | Database["public"]["Enums"]["invoice_fulfillment_method"]
            | null
          grace_until: string | null
          id: string
          last_auto_charge_at: string | null
          last_auto_charge_error: string | null
          operator_id: string
          paid_at: string | null
          refunded_at: string | null
          shipped_at: string | null
          shipping_address: Json | null
          shipping_carrier: string | null
          shipping_cents: number
          shipping_label_purchased_at: string | null
          shipping_label_url: string | null
          shipping_tracking_number: string | null
          square_payment_id: string | null
          square_refund_id: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          stripe_charge_id: string | null
          stripe_payment_intent_id: string | null
          subtotal_cents: number
          tax_cents: number
          total_cents: number
          updated_at: string
        }
        Insert: {
          application_fee_cents?: number
          auction_id: string
          authentication_client_secret?: string | null
          authentication_required_at?: string | null
          auto_charge_attempt_count?: number
          bidder_id: string
          buyer_premium_cents?: number
          created_at?: string
          delivered_at?: string | null
          dispute_id?: string | null
          dispute_reason?: string | null
          dispute_status?: string | null
          disputed_at?: string | null
          easypost_rate_id?: string | null
          easypost_shipment_id?: string | null
          evidence_due_by?: string | null
          fulfillment_method?:
            | Database["public"]["Enums"]["invoice_fulfillment_method"]
            | null
          grace_until?: string | null
          id?: string
          last_auto_charge_at?: string | null
          last_auto_charge_error?: string | null
          operator_id: string
          paid_at?: string | null
          refunded_at?: string | null
          shipped_at?: string | null
          shipping_address?: Json | null
          shipping_carrier?: string | null
          shipping_cents?: number
          shipping_label_purchased_at?: string | null
          shipping_label_url?: string | null
          shipping_tracking_number?: string | null
          square_payment_id?: string | null
          square_refund_id?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_charge_id?: string | null
          stripe_payment_intent_id?: string | null
          subtotal_cents?: number
          tax_cents?: number
          total_cents?: number
          updated_at?: string
        }
        Update: {
          application_fee_cents?: number
          auction_id?: string
          authentication_client_secret?: string | null
          authentication_required_at?: string | null
          auto_charge_attempt_count?: number
          bidder_id?: string
          buyer_premium_cents?: number
          created_at?: string
          delivered_at?: string | null
          dispute_id?: string | null
          dispute_reason?: string | null
          dispute_status?: string | null
          disputed_at?: string | null
          easypost_rate_id?: string | null
          easypost_shipment_id?: string | null
          evidence_due_by?: string | null
          fulfillment_method?:
            | Database["public"]["Enums"]["invoice_fulfillment_method"]
            | null
          grace_until?: string | null
          id?: string
          last_auto_charge_at?: string | null
          last_auto_charge_error?: string | null
          operator_id?: string
          paid_at?: string | null
          refunded_at?: string | null
          shipped_at?: string | null
          shipping_address?: Json | null
          shipping_carrier?: string | null
          shipping_cents?: number
          shipping_label_purchased_at?: string | null
          shipping_label_url?: string | null
          shipping_tracking_number?: string | null
          square_payment_id?: string | null
          square_refund_id?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_charge_id?: string | null
          stripe_payment_intent_id?: string | null
          subtotal_cents?: number
          tax_cents?: number
          total_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_auction_id_fkey"
            columns: ["auction_id"]
            isOneToOne: false
            referencedRelation: "auctions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "invoices_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      loads: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string | null
          id: string
          import_id: string | null
          notes: string | null
          operator_id: string
          purchase_cost_cents: number | null
          purchase_date: string | null
          source_name: string
          type: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          import_id?: string | null
          notes?: string | null
          operator_id: string
          purchase_cost_cents?: number | null
          purchase_date?: string | null
          source_name: string
          type: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          import_id?: string | null
          notes?: string | null
          operator_id?: string
          purchase_cost_cents?: number | null
          purchase_date?: string | null
          source_name?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "loads_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loads_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "loads_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loads_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      lot_import_batch_skips: {
        Row: {
          created_at: string
          id: string
          import_batch_id: string
          row_data: Json | null
          row_index: number
          skip_reason: string
        }
        Insert: {
          created_at?: string
          id?: string
          import_batch_id: string
          row_data?: Json | null
          row_index: number
          skip_reason: string
        }
        Update: {
          created_at?: string
          id?: string
          import_batch_id?: string
          row_data?: Json | null
          row_index?: number
          skip_reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "lot_import_batch_skips_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "lot_import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      lot_import_batches: {
        Row: {
          column_mapping: Json
          created_at: string
          error_message: string | null
          filename: string | null
          id: string
          imported_by: string | null
          inserted_count: number
          operator_id: string
          rolled_back_at: string | null
          row_count: number
          skipped_count: number
          source_label: string | null
          status: string
        }
        Insert: {
          column_mapping?: Json
          created_at?: string
          error_message?: string | null
          filename?: string | null
          id?: string
          imported_by?: string | null
          inserted_count?: number
          operator_id: string
          rolled_back_at?: string | null
          row_count?: number
          skipped_count?: number
          source_label?: string | null
          status?: string
        }
        Update: {
          column_mapping?: Json
          created_at?: string
          error_message?: string | null
          filename?: string | null
          id?: string
          imported_by?: string | null
          inserted_count?: number
          operator_id?: string
          rolled_back_at?: string | null
          row_count?: number
          skipped_count?: number
          source_label?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "lot_import_batches_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "lot_import_batches_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lot_import_batches_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      lot_status_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          context: Json
          from_status: string | null
          id: number
          lot_id: string
          to_status: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          context?: Json
          from_status?: string | null
          id?: number
          lot_id: string
          to_status: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          context?: Json
          from_status?: string | null
          id?: number
          lot_id?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "lot_status_history_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
        ]
      }
      lot_sticker_pool: {
        Row: {
          claimed_at: string | null
          claimed_by_lot_id: string | null
          operator_id: string
          printed_at: string
          printed_batch_id: string
          printed_by: string | null
          qr_token: string
          sticker_code: string | null
        }
        Insert: {
          claimed_at?: string | null
          claimed_by_lot_id?: string | null
          operator_id: string
          printed_at?: string
          printed_batch_id: string
          printed_by?: string | null
          qr_token: string
          sticker_code?: string | null
        }
        Update: {
          claimed_at?: string | null
          claimed_by_lot_id?: string | null
          operator_id?: string
          printed_at?: string
          printed_batch_id?: string
          printed_by?: string | null
          qr_token?: string
          sticker_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lot_sticker_pool_claimed_by_lot_id_fkey"
            columns: ["claimed_by_lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lot_sticker_pool_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "lot_sticker_pool_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lot_sticker_pool_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      lots: {
        Row: {
          asin: string | null
          auction_id: string | null
          bid_count: number
          brand: string | null
          client_dedup_token: string | null
          canceled_at: string | null
          canceled_by: string | null
          category: string | null
          category_id: string | null
          close_at: string | null
          closed_at: string | null
          condition: Database["public"]["Enums"]["lot_condition"]
          cost_cents: number | null
          created_at: string
          current_bid_cents: number | null
          current_bid_id: string | null
          deleted_at: string | null
          deleted_by: string | null
          description: string | null
          /**
           * PostgREST computed column (mig 0315) — the box label resolved over
           * the lineage server-side. Read-only, so it appears on Row only, and
           * `supabase gen types` does not emit computed columns: keep this by
           * hand when regenerating this file.
           */
          display_code: string | null
          dutch_decline_per_minute_cents: number | null
          dutch_floor_cents: number | null
          dutch_start_cents: number | null
          early_access_until: string | null
          external_code: string | null
          flagged_at: string | null
          flagged_for_disposal: boolean
          flagged_reason: string | null
          flat_price_cents: number | null
          fnsku: string | null
          id: string
          import_row_id: string | null
          intake_at: string | null
          intake_bin_id: string | null
          last_relisted_at: string | null
          legacy_lot_code: string | null
          legacy_platform: string | null
          load_id: string | null
          load_number: string | null
          lot_code: string
          lot_import_batch_id: string | null
          lot_number: number | null
          lpn: string | null
          manufacture_sku: string | null
          model: string | null
          mpn: string | null
          msrp_cents: number | null
          operator_id: string
          photo_urls: string[]
          product_sku: string | null
          qr_rotated_at: string | null
          qr_token: string
          relist_count: number
          relisted_from_lot_id: string | null
          reserve_cents: number | null
          search_tsv: unknown
          site_sku: string | null
          source: string | null
          starting_bid_cents: number
          status: Database["public"]["Enums"]["lot_status"]
          sticker_code: string | null
          title: string
          /**
           * 0451: display label for unit_qty, e.g. 'sq ft'. NULL for every
           * standard lot. Set together with unit_qty; neither is enforced
           * yet (PR 4).
           */
          unit_label: string | null
          /**
           * 0451: quantity a per_unit lot's total divides into (e.g. 247
           * square feet). NULL for every standard lot. Nothing reads this
           * yet (PR 3).
           */
          unit_qty: number | null
          upc: string | null
          updated_at: string
          vendor: string | null
          warehouse_id: string | null
          winner_bidder_id: string | null
        }
        Insert: {
          asin?: string | null
          auction_id?: string | null
          bid_count?: number
          brand?: string | null
          client_dedup_token?: string | null
          canceled_at?: string | null
          canceled_by?: string | null
          category?: string | null
          category_id?: string | null
          close_at?: string | null
          closed_at?: string | null
          condition?: Database["public"]["Enums"]["lot_condition"]
          cost_cents?: number | null
          created_at?: string
          current_bid_cents?: number | null
          current_bid_id?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          dutch_decline_per_minute_cents?: number | null
          dutch_floor_cents?: number | null
          dutch_start_cents?: number | null
          early_access_until?: string | null
          external_code?: string | null
          flagged_at?: string | null
          flagged_for_disposal?: boolean
          flagged_reason?: string | null
          flat_price_cents?: number | null
          fnsku?: string | null
          id?: string
          import_row_id?: string | null
          intake_at?: string | null
          intake_bin_id?: string | null
          last_relisted_at?: string | null
          legacy_lot_code?: string | null
          legacy_platform?: string | null
          load_id?: string | null
          load_number?: string | null
          lot_code: string
          lot_import_batch_id?: string | null
          lot_number?: number | null
          lpn?: string | null
          manufacture_sku?: string | null
          model?: string | null
          mpn?: string | null
          msrp_cents?: number | null
          operator_id: string
          photo_urls?: string[]
          product_sku?: string | null
          qr_rotated_at?: string | null
          qr_token?: string
          relist_count?: number
          relisted_from_lot_id?: string | null
          reserve_cents?: number | null
          search_tsv?: unknown
          site_sku?: string | null
          source?: string | null
          starting_bid_cents?: number
          status?: Database["public"]["Enums"]["lot_status"]
          sticker_code?: string | null
          title: string
          unit_label?: string | null
          unit_qty?: number | null
          upc?: string | null
          updated_at?: string
          vendor?: string | null
          warehouse_id?: string | null
          winner_bidder_id?: string | null
        }
        Update: {
          asin?: string | null
          auction_id?: string | null
          bid_count?: number
          brand?: string | null
          client_dedup_token?: string | null
          canceled_at?: string | null
          canceled_by?: string | null
          category?: string | null
          category_id?: string | null
          close_at?: string | null
          closed_at?: string | null
          condition?: Database["public"]["Enums"]["lot_condition"]
          cost_cents?: number | null
          created_at?: string
          current_bid_cents?: number | null
          current_bid_id?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          dutch_decline_per_minute_cents?: number | null
          dutch_floor_cents?: number | null
          dutch_start_cents?: number | null
          early_access_until?: string | null
          external_code?: string | null
          flagged_at?: string | null
          flagged_for_disposal?: boolean
          flagged_reason?: string | null
          flat_price_cents?: number | null
          fnsku?: string | null
          id?: string
          import_row_id?: string | null
          intake_at?: string | null
          intake_bin_id?: string | null
          last_relisted_at?: string | null
          legacy_lot_code?: string | null
          legacy_platform?: string | null
          load_id?: string | null
          load_number?: string | null
          lot_code?: string
          lot_import_batch_id?: string | null
          lot_number?: number | null
          lpn?: string | null
          manufacture_sku?: string | null
          model?: string | null
          mpn?: string | null
          msrp_cents?: number | null
          operator_id?: string
          photo_urls?: string[]
          product_sku?: string | null
          qr_rotated_at?: string | null
          qr_token?: string
          relist_count?: number
          relisted_from_lot_id?: string | null
          reserve_cents?: number | null
          search_tsv?: unknown
          site_sku?: string | null
          source?: string | null
          starting_bid_cents?: number
          status?: Database["public"]["Enums"]["lot_status"]
          sticker_code?: string | null
          title?: string
          unit_label?: string | null
          unit_qty?: number | null
          upc?: string | null
          updated_at?: string
          vendor?: string | null
          warehouse_id?: string | null
          winner_bidder_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lots_auction_id_fkey"
            columns: ["auction_id"]
            isOneToOne: false
            referencedRelation: "auctions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_current_bid_fk"
            columns: ["current_bid_id"]
            isOneToOne: false
            referencedRelation: "bids"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_import_row_id_fkey"
            columns: ["import_row_id"]
            isOneToOne: false
            referencedRelation: "import_rows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_intake_bin_id_fkey"
            columns: ["intake_bin_id"]
            isOneToOne: false
            referencedRelation: "bins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "loads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_lot_import_batch_fk"
            columns: ["lot_import_batch_id"]
            isOneToOne: false
            referencedRelation: "lot_import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "lots_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_relisted_from_lot_id_fkey"
            columns: ["relisted_from_lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "walk_progress_per_warehouse"
            referencedColumns: ["warehouse_id"]
          },
          {
            foreignKeyName: "lots_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lots_winner_bidder_id_fkey"
            columns: ["winner_bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications_outbox: {
        Row: {
          attempt_count: number
          created_at: string
          email_attempt_count: number
          emailed_at: string | null
          id: string
          idempotency_key: string | null
          kind: Database["public"]["Enums"]["notification_kind"]
          last_email_error: string | null
          last_error: string | null
          last_sms_error: string | null
          payload: Json
          processed_at: string | null
          sms_attempt_count: number
          smsed_at: string | null
          target_user_id: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          email_attempt_count?: number
          emailed_at?: string | null
          id?: string
          idempotency_key?: string | null
          kind: Database["public"]["Enums"]["notification_kind"]
          last_email_error?: string | null
          last_error?: string | null
          last_sms_error?: string | null
          payload?: Json
          processed_at?: string | null
          sms_attempt_count?: number
          smsed_at?: string | null
          target_user_id: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          email_attempt_count?: number
          emailed_at?: string | null
          id?: string
          idempotency_key?: string | null
          kind?: Database["public"]["Enums"]["notification_kind"]
          last_email_error?: string | null
          last_error?: string | null
          last_sms_error?: string | null
          payload?: Json
          processed_at?: string | null
          sms_attempt_count?: number
          smsed_at?: string | null
          target_user_id?: string
        }
        Relationships: []
      }
      operator_audit_log: {
        Row: {
          action_type: string
          actor_user_id: string | null
          after_state: Json | null
          before_state: Json | null
          created_at: string
          id: number
          operator_id: string
          reason_note: string | null
          target_id: string | null
        }
        Insert: {
          action_type: string
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: number
          operator_id: string
          reason_note?: string | null
          target_id?: string | null
        }
        Update: {
          action_type?: string
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: number
          operator_id?: string
          reason_note?: string | null
          target_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "operator_audit_log_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_audit_log_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_audit_log_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_bidder_relations: {
        Row: {
          bidder_id: string
          created_at: string
          internal_notes: string | null
          operator_id: string
          suspended_at: string | null
          suspended_reason: string | null
          updated_at: string
        }
        Insert: {
          bidder_id: string
          created_at?: string
          internal_notes?: string | null
          operator_id: string
          suspended_at?: string | null
          suspended_reason?: string | null
          updated_at?: string
        }
        Update: {
          bidder_id?: string
          created_at?: string
          internal_notes?: string | null
          operator_id?: string
          suspended_at?: string | null
          suspended_reason?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_bidder_relations_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_bidder_relations_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_bidder_relations_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_bidder_relations_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_invites: {
        Row: {
          business_name_hint: string | null
          consumed_at: string | null
          consumed_by_operator_id: string | null
          created_at: string
          created_by: string | null
          email: string
          expires_at: string
          id: string
          notes: string | null
          request_id: string | null
          token: string
        }
        Insert: {
          business_name_hint?: string | null
          consumed_at?: string | null
          consumed_by_operator_id?: string | null
          created_at?: string
          created_by?: string | null
          email: string
          expires_at?: string
          id?: string
          notes?: string | null
          request_id?: string | null
          token: string
        }
        Update: {
          business_name_hint?: string | null
          consumed_at?: string | null
          consumed_by_operator_id?: string | null
          created_at?: string
          created_by?: string | null
          email?: string
          expires_at?: string
          id?: string
          notes?: string | null
          request_id?: string | null
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_invites_consumed_by_operator_id_fkey"
            columns: ["consumed_by_operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_invites_consumed_by_operator_id_fkey"
            columns: ["consumed_by_operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_invites_consumed_by_operator_id_fkey"
            columns: ["consumed_by_operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_invites_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "operator_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_policies: {
        Row: {
          admin_can_refund_outside_window: boolean
          content_hash: string
          created_at: string
          created_by: string | null
          dispute_response_hours: number
          effective_at: string
          identity_check_threshold_cents: number
          no_show_policy: string
          operator_id: string
          payment_window_hours: number
          pickup_window_days: number
          published: boolean
          refund_md: string
          refund_window_post_pickup_hours: number
          relist_fee_cents: number
          require_identity_check: boolean
          require_signature: boolean
          restock_fee_cents: number
          shipping_md: string
          shipping_offered: boolean
          terms_md: string
          version: number
        }
        Insert: {
          admin_can_refund_outside_window?: boolean
          content_hash: string
          created_at?: string
          created_by?: string | null
          dispute_response_hours?: number
          effective_at?: string
          identity_check_threshold_cents?: number
          no_show_policy?: string
          operator_id: string
          payment_window_hours?: number
          pickup_window_days?: number
          published?: boolean
          refund_md: string
          refund_window_post_pickup_hours?: number
          relist_fee_cents?: number
          require_identity_check?: boolean
          require_signature?: boolean
          restock_fee_cents?: number
          shipping_md: string
          shipping_offered?: boolean
          terms_md: string
          version: number
        }
        Update: {
          admin_can_refund_outside_window?: boolean
          content_hash?: string
          created_at?: string
          created_by?: string | null
          dispute_response_hours?: number
          effective_at?: string
          identity_check_threshold_cents?: number
          no_show_policy?: string
          operator_id?: string
          payment_window_hours?: number
          pickup_window_days?: number
          published?: boolean
          refund_md?: string
          refund_window_post_pickup_hours?: number
          relist_fee_cents?: number
          require_identity_check?: boolean
          require_signature?: boolean
          restock_fee_cents?: number
          shipping_md?: string
          shipping_offered?: boolean
          terms_md?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "operator_policies_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_policies_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_policies_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_policy_acceptances: {
        Row: {
          accepted_at: string
          id: string
          ip_address: string | null
          operator_id: string
          user_agent: string | null
          user_id: string
          version: number
        }
        Insert: {
          accepted_at?: string
          id?: string
          ip_address?: string | null
          operator_id: string
          user_agent?: string | null
          user_id: string
          version: number
        }
        Update: {
          accepted_at?: string
          id?: string
          ip_address?: string | null
          operator_id?: string
          user_agent?: string | null
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "operator_policy_acceptances_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_policy_acceptances_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_policy_acceptances_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_policy_acceptances_operator_id_version_fkey"
            columns: ["operator_id", "version"]
            isOneToOne: false
            referencedRelation: "operator_policies"
            referencedColumns: ["operator_id", "version"]
          },
        ]
      }
      operator_pro_plans: {
        Row: {
          active: boolean
          created_at: string
          extended_pickup_days: number
          extra_grace_hours: number
          id: string
          name: string
          operator_id: string
          price_cents: number
          staging_prep: boolean
          stripe_price_id: string | null
          stripe_product_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          extended_pickup_days?: number
          extra_grace_hours?: number
          id?: string
          name: string
          operator_id: string
          price_cents: number
          staging_prep?: boolean
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          extended_pickup_days?: number
          extra_grace_hours?: number
          id?: string
          name?: string
          operator_id?: string
          price_cents?: number
          staging_prep?: boolean
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_pro_plans_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_pro_plans_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_pro_plans_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_requests: {
        Row: {
          business_name: string | null
          created_at: string
          description: string | null
          email: string
          id: string
          invite_id: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          status: string
        }
        Insert: {
          business_name?: string | null
          created_at?: string
          description?: string | null
          email: string
          id?: string
          invite_id?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
        }
        Update: {
          business_name?: string | null
          created_at?: string
          description?: string | null
          email?: string
          id?: string
          invite_id?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_requests_invite_id_fk"
            columns: ["invite_id"]
            isOneToOne: false
            referencedRelation: "operator_invites"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_role_capabilities: {
        Row: {
          capability: string
          role: Database["public"]["Enums"]["operator_user_role"]
        }
        Insert: {
          capability: string
          role: Database["public"]["Enums"]["operator_user_role"]
        }
        Update: {
          capability?: string
          role?: Database["public"]["Enums"]["operator_user_role"]
        }
        Relationships: []
      }
      operator_settlements: {
        Row: {
          amount_cents: number
          application_fee_cents: number
          attempt_count: number
          created_at: string
          frozen_for_dispute: boolean
          id: string
          invoice_id: string
          last_error: string | null
          operator_id: string
          refund_cents: number
          release_at: string
          status: Database["public"]["Enums"]["settlement_status"]
          stripe_transfer_id: string | null
          transferred_at: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          application_fee_cents: number
          attempt_count?: number
          created_at?: string
          frozen_for_dispute?: boolean
          id?: string
          invoice_id: string
          last_error?: string | null
          operator_id: string
          refund_cents?: number
          release_at: string
          status?: Database["public"]["Enums"]["settlement_status"]
          stripe_transfer_id?: string | null
          transferred_at?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          application_fee_cents?: number
          attempt_count?: number
          created_at?: string
          frozen_for_dispute?: boolean
          id?: string
          invoice_id?: string
          last_error?: string | null
          operator_id?: string
          refund_cents?: number
          release_at?: string
          status?: Database["public"]["Enums"]["settlement_status"]
          stripe_transfer_id?: string | null
          transferred_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_settlements_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_settlements_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_settlements_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_settlements_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_shipping_config: {
        Row: {
          created_at: string
          default_pkg_height_in: number
          default_pkg_length_in: number
          default_pkg_weight_oz: number
          default_pkg_width_in: number
          easypost_account_token: string | null
          handling_fee_cents: number
          operator_id: string
          return_address: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_pkg_height_in?: number
          default_pkg_length_in?: number
          default_pkg_weight_oz?: number
          default_pkg_width_in?: number
          easypost_account_token?: string | null
          handling_fee_cents?: number
          operator_id: string
          return_address: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_pkg_height_in?: number
          default_pkg_length_in?: number
          default_pkg_weight_oz?: number
          default_pkg_width_in?: number
          easypost_account_token?: string | null
          handling_fee_cents?: number
          operator_id?: string
          return_address?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_shipping_config_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: true
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_shipping_config_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: true
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_shipping_config_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: true
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_tax_documents: {
        Row: {
          archived_at: string | null
          created_at: string
          doc_type: string
          file_name: string
          id: string
          operator_id: string
          state: string | null
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          doc_type?: string
          file_name: string
          id?: string
          operator_id: string
          state?: string | null
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          doc_type?: string
          file_name?: string
          id?: string
          operator_id?: string
          state?: string | null
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "operator_tax_documents_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_tax_documents_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_tax_documents_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_users: {
        Row: {
          accepted_at: string | null
          admin_first_seen_at: string | null
          created_at: string
          display_name: string | null
          email: string
          force_password_rotate: boolean
          id: string
          invited_at: string
          operator_id: string
          role: Database["public"]["Enums"]["operator_user_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          accepted_at?: string | null
          admin_first_seen_at?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          force_password_rotate?: boolean
          id?: string
          invited_at?: string
          operator_id: string
          role: Database["public"]["Enums"]["operator_user_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          accepted_at?: string | null
          admin_first_seen_at?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          force_password_rotate?: boolean
          id?: string
          invited_at?: string
          operator_id?: string
          role?: Database["public"]["Enums"]["operator_user_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_users_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "operator_users_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_users_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operators: {
        Row: {
          ai_billing_markup_bps: number
          application_fee_bps: number
          auto_charge_grace_hours: number
          auto_flag_disposal_at_strikes: number
          auto_relist_enabled: boolean
          auto_relist_max_attempts: number
          auto_relist_mode: string
          bid_increment_schedule: Json | null
          bidder_features: Json
          brand_color: string | null
          business_name: string
          code: string
          collect_sales_tax: boolean
          contact_email: string
          contact_phone: string | null
          created_at: string
          custom_terms_md: string | null
          default_buyer_premium_bps: number
          default_soft_close_minutes: number
          dispute_window_days: number
          forfeit_cooldown_days: number
          founder_locked_until: string | null
          founder_pricing: boolean
          id: string
          is_demo: boolean
          lapse_at: string | null
          legal_name: string | null
          logo_url: string | null
          membership_fee_bps: number
          monthly_ai_budget_cents: number
          monthly_subscription_cents: number
          next_lot_seq: number
          no_show_forfeit_threshold: number
          offers_pickup: boolean
          offers_shipping: boolean
          pickup_grace_extension_hours: number
          pickup_hours_text: string | null
          platform_stripe_customer_id: string | null
          platform_stripe_subscription_id: string | null
          pro_early_access_minutes: number
          pro_enabled: boolean
          pro_last_chance_members_only: boolean
          pro_monthly_cents: number
          pro_msrp_filter_enabled: boolean
          pro_stripe_price_id: string | null
          pro_stripe_product_id: string | null
          settlement_hold_days: number
          slug: string
          status: Database["public"]["Enums"]["operator_status"]
          stripe_account_id: string | null
          stripe_charges_enabled: boolean
          stripe_onboarding_complete: boolean
          stripe_onboarding_skipped: boolean
          stripe_requirements_due: Json | null
          stripe_tax_acknowledged_at: string | null
          subscription_status: Database["public"]["Enums"]["subscription_status"]
          subscription_tier: string
          tax_mode: string
          updated_at: string
        }
        Insert: {
          ai_billing_markup_bps?: number
          application_fee_bps?: number
          auto_charge_grace_hours?: number
          auto_flag_disposal_at_strikes?: number
          auto_relist_enabled?: boolean
          auto_relist_max_attempts?: number
          auto_relist_mode?: string
          bid_increment_schedule?: Json | null
          bidder_features?: Json
          brand_color?: string | null
          business_name: string
          code: string
          collect_sales_tax?: boolean
          contact_email: string
          contact_phone?: string | null
          created_at?: string
          custom_terms_md?: string | null
          default_buyer_premium_bps?: number
          default_soft_close_minutes?: number
          dispute_window_days?: number
          forfeit_cooldown_days?: number
          founder_locked_until?: string | null
          founder_pricing?: boolean
          id?: string
          is_demo?: boolean
          lapse_at?: string | null
          legal_name?: string | null
          logo_url?: string | null
          membership_fee_bps?: number
          monthly_ai_budget_cents?: number
          monthly_subscription_cents?: number
          next_lot_seq?: number
          no_show_forfeit_threshold?: number
          offers_pickup?: boolean
          offers_shipping?: boolean
          pickup_grace_extension_hours?: number
          pickup_hours_text?: string | null
          platform_stripe_customer_id?: string | null
          platform_stripe_subscription_id?: string | null
          pro_early_access_minutes?: number
          pro_enabled?: boolean
          pro_last_chance_members_only?: boolean
          pro_monthly_cents?: number
          pro_msrp_filter_enabled?: boolean
          pro_stripe_price_id?: string | null
          pro_stripe_product_id?: string | null
          settlement_hold_days?: number
          slug: string
          status?: Database["public"]["Enums"]["operator_status"]
          stripe_account_id?: string | null
          stripe_charges_enabled?: boolean
          stripe_onboarding_complete?: boolean
          stripe_onboarding_skipped?: boolean
          stripe_requirements_due?: Json | null
          stripe_tax_acknowledged_at?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          subscription_tier?: string
          tax_mode?: string
          updated_at?: string
        }
        Update: {
          ai_billing_markup_bps?: number
          application_fee_bps?: number
          auto_charge_grace_hours?: number
          auto_flag_disposal_at_strikes?: number
          auto_relist_enabled?: boolean
          auto_relist_max_attempts?: number
          auto_relist_mode?: string
          bid_increment_schedule?: Json | null
          bidder_features?: Json
          brand_color?: string | null
          business_name?: string
          code?: string
          collect_sales_tax?: boolean
          contact_email?: string
          contact_phone?: string | null
          created_at?: string
          custom_terms_md?: string | null
          default_buyer_premium_bps?: number
          default_soft_close_minutes?: number
          dispute_window_days?: number
          forfeit_cooldown_days?: number
          founder_locked_until?: string | null
          founder_pricing?: boolean
          id?: string
          is_demo?: boolean
          lapse_at?: string | null
          legal_name?: string | null
          logo_url?: string | null
          membership_fee_bps?: number
          monthly_ai_budget_cents?: number
          monthly_subscription_cents?: number
          next_lot_seq?: number
          no_show_forfeit_threshold?: number
          offers_pickup?: boolean
          offers_shipping?: boolean
          pickup_grace_extension_hours?: number
          pickup_hours_text?: string | null
          platform_stripe_customer_id?: string | null
          platform_stripe_subscription_id?: string | null
          pro_early_access_minutes?: number
          pro_enabled?: boolean
          pro_last_chance_members_only?: boolean
          pro_monthly_cents?: number
          pro_msrp_filter_enabled?: boolean
          pro_stripe_price_id?: string | null
          pro_stripe_product_id?: string | null
          settlement_hold_days?: number
          slug?: string
          status?: Database["public"]["Enums"]["operator_status"]
          stripe_account_id?: string | null
          stripe_charges_enabled?: boolean
          stripe_onboarding_complete?: boolean
          stripe_onboarding_skipped?: boolean
          stripe_requirements_due?: Json | null
          stripe_tax_acknowledged_at?: string | null
          subscription_status?: Database["public"]["Enums"]["subscription_status"]
          subscription_tier?: string
          tax_mode?: string
          updated_at?: string
        }
        Relationships: []
      }
      payment_followups: {
        Row: {
          attempt_count: number
          bidder_id: string
          created_at: string
          final_status: string | null
          invoice_id: string
          last_attempt_at: string
          next_attempt_at: string
          operator_id: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          bidder_id: string
          created_at?: string
          final_status?: string | null
          invoice_id: string
          last_attempt_at?: string
          next_attempt_at: string
          operator_id: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          bidder_id?: string
          created_at?: string
          final_status?: string | null
          invoice_id?: string
          last_attempt_at?: string
          next_attempt_at?: string
          operator_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_followups_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_followups_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_followups_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "payment_followups_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_followups_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      pickups: {
        Row: {
          bidder_check_in_token: string
          bidder_signature_url: string | null
          checked_in_at: string | null
          completed_at: string | null
          created_at: string
          id: string
          invoice_id: string
          pickup_mode: string | null
          scheduled_at: string | null
          status: Database["public"]["Enums"]["pickup_status"]
          updated_at: string
          warehouse_id: string
        }
        Insert: {
          bidder_check_in_token?: string
          bidder_signature_url?: string | null
          checked_in_at?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          invoice_id: string
          pickup_mode?: string | null
          scheduled_at?: string | null
          status?: Database["public"]["Enums"]["pickup_status"]
          updated_at?: string
          warehouse_id: string
        }
        Update: {
          bidder_check_in_token?: string
          bidder_signature_url?: string | null
          checked_in_at?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          invoice_id?: string
          pickup_mode?: string | null
          scheduled_at?: string | null
          status?: Database["public"]["Enums"]["pickup_status"]
          updated_at?: string
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pickups_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pickups_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "walk_progress_per_warehouse"
            referencedColumns: ["warehouse_id"]
          },
          {
            foreignKeyName: "pickups_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          id: boolean
          note: string | null
          payments_disabled: boolean
          single_account_mode: boolean
          updated_at: string
        }
        Insert: {
          id?: boolean
          note?: string | null
          payments_disabled?: boolean
          single_account_mode?: boolean
          updated_at?: string
        }
        Update: {
          id?: boolean
          note?: string | null
          payments_disabled?: boolean
          single_account_mode?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      policy_versions: {
        Row: {
          content_hash: string
          effective_at: string
          published: boolean
          slug: string
          version: number
        }
        Insert: {
          content_hash: string
          effective_at?: string
          published?: boolean
          slug: string
          version: number
        }
        Update: {
          content_hash?: string
          effective_at?: string
          published?: boolean
          slug?: string
          version?: number
        }
        Relationships: []
      }
      processed_webhook_events: {
        Row: {
          event_type: string
          processed_at: string | null
          stripe_event_id: string
        }
        Insert: {
          event_type: string
          processed_at?: string | null
          stripe_event_id: string
        }
        Update: {
          event_type?: string
          processed_at?: string | null
          stripe_event_id?: string
        }
        Relationships: []
      }
      product_cache_warm_jobs: {
        Row: {
          attempt_count: number
          enqueued_at: string
          last_attempt_at: string | null
          last_error: string | null
          source: string
          upc: string
        }
        Insert: {
          attempt_count?: number
          enqueued_at?: string
          last_attempt_at?: string | null
          last_error?: string | null
          source?: string
          upc: string
        }
        Update: {
          attempt_count?: number
          enqueued_at?: string
          last_attempt_at?: string | null
          last_error?: string | null
          source?: string
          upc?: string
        }
        Relationships: []
      }
      product_lookups: {
        Row: {
          asin: string | null
          avg_asking_cents: number | null
          brand: string | null
          category_id: string | null
          category_raw: string | null
          confidence: string
          created_at: string
          description: string | null
          external_codes: string[]
          fnsku: string | null
          identity_refreshed_at: string
          image_urls: string[]
          lpn: string | null
          median_sold_cents: number | null
          model: string | null
          mpn: string | null
          msrp_cents: number | null
          prices: Json
          prices_refreshed_at: string | null
          sold_comps: Json
          sources: string[]
          specs: string | null
          start_bid_cents: number | null
          title: string | null
          upc: string
          updated_at: string
        }
        Insert: {
          asin?: string | null
          avg_asking_cents?: number | null
          brand?: string | null
          category_id?: string | null
          category_raw?: string | null
          confidence?: string
          created_at?: string
          description?: string | null
          external_codes?: string[]
          fnsku?: string | null
          identity_refreshed_at?: string
          image_urls?: string[]
          lpn?: string | null
          median_sold_cents?: number | null
          model?: string | null
          mpn?: string | null
          msrp_cents?: number | null
          prices?: Json
          prices_refreshed_at?: string | null
          sold_comps?: Json
          sources?: string[]
          specs?: string | null
          start_bid_cents?: number | null
          title?: string | null
          upc: string
          updated_at?: string
        }
        Update: {
          asin?: string | null
          avg_asking_cents?: number | null
          brand?: string | null
          category_id?: string | null
          category_raw?: string | null
          confidence?: string
          created_at?: string
          description?: string | null
          external_codes?: string[]
          fnsku?: string | null
          identity_refreshed_at?: string
          image_urls?: string[]
          lpn?: string | null
          median_sold_cents?: number | null
          model?: string | null
          mpn?: string | null
          msrp_cents?: number | null
          prices?: Json
          prices_refreshed_at?: string | null
          sold_comps?: Json
          sources?: string[]
          specs?: string | null
          start_bid_cents?: number | null
          title?: string | null
          upc?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_lookups_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      refund_jobs: {
        Row: {
          amount_cents: number
          attempts: number
          created_at: string
          created_by: string | null
          id: string
          invoice_id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          lot_id: string | null
          operator_id: string
          processed_at: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          reason_note: string | null
          status: string
          stripe_refund_id: string | null
          sub_reason: Database["public"]["Enums"]["refund_reason"] | null
        }
        Insert: {
          amount_cents: number
          attempts?: number
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          lot_id?: string | null
          operator_id: string
          processed_at?: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          reason_note?: string | null
          status?: string
          stripe_refund_id?: string | null
          sub_reason?: Database["public"]["Enums"]["refund_reason"] | null
        }
        Update: {
          amount_cents?: number
          attempts?: number
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          lot_id?: string | null
          operator_id?: string
          processed_at?: string | null
          reason?: Database["public"]["Enums"]["refund_reason"]
          reason_note?: string | null
          status?: string
          stripe_refund_id?: string | null
          sub_reason?: Database["public"]["Enums"]["refund_reason"] | null
        }
        Relationships: [
          {
            foreignKeyName: "refund_jobs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_jobs_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_jobs_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "refund_jobs_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_jobs_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_searches: {
        Row: {
          bidder_id: string
          created_at: string
          criteria: Json
          id: string
          last_matched_at: string | null
          name: string
          notify: boolean
          updated_at: string
        }
        Insert: {
          bidder_id: string
          created_at?: string
          criteria?: Json
          id?: string
          last_matched_at?: string | null
          name: string
          notify?: boolean
          updated_at?: string
        }
        Update: {
          bidder_id?: string
          created_at?: string
          criteria?: Json
          id?: string
          last_matched_at?: string | null
          name?: string
          notify?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_searches_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
        ]
      }
      terms_acceptances: {
        Row: {
          accepted_at: string
          consent_method: string
          id: string
          ip_address: string | null
          slug: string
          user_agent: string | null
          user_id: string
          version: number
        }
        Insert: {
          accepted_at?: string
          consent_method: string
          id?: string
          ip_address?: string | null
          slug: string
          user_agent?: string | null
          user_id: string
          version: number
        }
        Update: {
          accepted_at?: string
          consent_method?: string
          id?: string
          ip_address?: string | null
          slug?: string
          user_agent?: string | null
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "terms_acceptances_slug_version_fkey"
            columns: ["slug", "version"]
            isOneToOne: false
            referencedRelation: "policy_versions"
            referencedColumns: ["slug", "version"]
          },
        ]
      }
      warehouse_landmarks: {
        Row: {
          coord_x_m: number
          coord_y_m: number
          created_at: string
          id: string
          kind: string | null
          name: string
          scan_pose: Json | null
          scanned_at: string
          updated_at: string
          warehouse_id: string
        }
        Insert: {
          coord_x_m: number
          coord_y_m: number
          created_at?: string
          id?: string
          kind?: string | null
          name: string
          scan_pose?: Json | null
          scanned_at?: string
          updated_at?: string
          warehouse_id: string
        }
        Update: {
          coord_x_m?: number
          coord_y_m?: number
          created_at?: string
          id?: string
          kind?: string | null
          name?: string
          scan_pose?: Json | null
          scanned_at?: string
          updated_at?: string
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "warehouse_landmarks_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "walk_progress_per_warehouse"
            referencedColumns: ["warehouse_id"]
          },
          {
            foreignKeyName: "warehouse_landmarks_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      warehouses: {
        Row: {
          active: boolean
          address_line1: string
          address_line2: string | null
          city: string
          country: string
          created_at: string
          customer_notice: string | null
          entrance_x_px: number | null
          entrance_y_px: number | null
          floor_plan_height_px: number | null
          floor_plan_uploaded_at: string | null
          floor_plan_url: string | null
          floor_plan_version: number
          floor_plan_width_px: number | null
          id: string
          name: string
          operator_id: string
          pickup_hours: Json
          pickup_instructions: string | null
          pickup_mode: string
          pickup_slot_capacity: number
          pickup_slot_minutes: number
          postal_code: string
          state: string
          timezone: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          address_line1: string
          address_line2?: string | null
          city: string
          country?: string
          created_at?: string
          customer_notice?: string | null
          entrance_x_px?: number | null
          entrance_y_px?: number | null
          floor_plan_height_px?: number | null
          floor_plan_uploaded_at?: string | null
          floor_plan_url?: string | null
          floor_plan_version?: number
          floor_plan_width_px?: number | null
          id?: string
          name: string
          operator_id: string
          pickup_hours?: Json
          pickup_instructions?: string | null
          pickup_mode?: string
          pickup_slot_capacity?: number
          pickup_slot_minutes?: number
          postal_code: string
          state: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          address_line1?: string
          address_line2?: string | null
          city?: string
          country?: string
          created_at?: string
          customer_notice?: string | null
          entrance_x_px?: number | null
          entrance_y_px?: number | null
          floor_plan_height_px?: number | null
          floor_plan_uploaded_at?: string | null
          floor_plan_url?: string | null
          floor_plan_version?: number
          floor_plan_width_px?: number | null
          id?: string
          name?: string
          operator_id?: string
          pickup_hours?: Json
          pickup_instructions?: string | null
          pickup_mode?: string
          pickup_slot_capacity?: number
          pickup_slot_minutes?: number
          postal_code?: string
          state?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "warehouses_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "warehouses_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warehouses_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      watchlist: {
        Row: {
          bidder_id: string
          created_at: string
          lot_id: string
        }
        Insert: {
          bidder_id: string
          created_at?: string
          lot_id: string
        }
        Update: {
          bidder_id?: string
          created_at?: string
          lot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "watchlist_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "bidders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "watchlist_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
        ]
      }
      zip_reference: {
        Row: {
          city: string
          county: string | null
          lat: number | null
          loaded_at: string
          lon: number | null
          postal_code: string
          source: string
          state: string
        }
        Insert: {
          city: string
          county?: string | null
          lat?: number | null
          loaded_at?: string
          lon?: number | null
          postal_code: string
          source?: string
          state: string
        }
        Update: {
          city?: string
          county?: string | null
          lat?: number | null
          loaded_at?: string
          lon?: number | null
          postal_code?: string
          source?: string
          state?: string
        }
        Relationships: []
      }
    }
    Views: {
      auction_timeline: {
        Row: {
          auction_id: string | null
          changed_at: string | null
          changed_by: string | null
          context: Json | null
          event_label: string | null
          from_status: string | null
          to_status: string | null
        }
        Insert: {
          auction_id?: string | null
          changed_at?: string | null
          changed_by?: string | null
          context?: Json | null
          event_label?: never
          from_status?: string | null
          to_status?: string | null
        }
        Update: {
          auction_id?: string | null
          changed_at?: string | null
          changed_by?: string | null
          context?: Json | null
          event_label?: never
          from_status?: string | null
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auction_status_history_auction_id_fkey"
            columns: ["auction_id"]
            isOneToOne: false
            referencedRelation: "auctions"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_timeline: {
        Row: {
          changed_at: string | null
          changed_by: string | null
          context: Json | null
          event_label: string | null
          from_status: string | null
          invoice_id: string | null
          to_status: string | null
        }
        Insert: {
          changed_at?: string | null
          changed_by?: string | null
          context?: Json | null
          event_label?: never
          from_status?: string | null
          invoice_id?: string | null
          to_status?: string | null
        }
        Update: {
          changed_at?: string | null
          changed_by?: string | null
          context?: Json | null
          event_label?: never
          from_status?: string | null
          invoice_id?: string | null
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_status_history_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      lot_timeline: {
        Row: {
          changed_at: string | null
          changed_by: string | null
          context: Json | null
          event_label: string | null
          from_status: string | null
          lot_id: string | null
          to_status: string | null
        }
        Insert: {
          changed_at?: string | null
          changed_by?: string | null
          context?: Json | null
          event_label?: never
          from_status?: string | null
          lot_id?: string | null
          to_status?: string | null
        }
        Update: {
          changed_at?: string | null
          changed_by?: string | null
          context?: Json | null
          event_label?: never
          from_status?: string | null
          lot_id?: string | null
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lot_status_history_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_ai_usage_mtd: {
        Row: {
          month: string | null
          operator_id: string | null
          raw_cost_cents: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_calls_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "ai_calls_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_calls_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_billing_mtd: {
        Row: {
          app_fee_collected_mtd_cents: number | null
          business_name: string | null
          founder_active: boolean | null
          founder_locked_until: string | null
          gmv_mtd_cents: number | null
          operator_id: string | null
          subscription_tier: string | null
        }
        Relationships: []
      }
      operators_public: {
        Row: {
          bid_increment_schedule: Json | null
          brand_color: string | null
          business_name: string | null
          default_buyer_premium_bps: number | null
          id: string | null
          logo_url: string | null
          offers_pickup: boolean | null
          offers_shipping: boolean | null
          slug: string | null
          status: Database["public"]["Enums"]["operator_status"] | null
        }
        Insert: {
          bid_increment_schedule?: Json | null
          brand_color?: string | null
          business_name?: string | null
          default_buyer_premium_bps?: number | null
          id?: string | null
          logo_url?: string | null
          offers_pickup?: boolean | null
          offers_shipping?: boolean | null
          slug?: string | null
          status?: Database["public"]["Enums"]["operator_status"] | null
        }
        Update: {
          bid_increment_schedule?: Json | null
          brand_color?: string | null
          business_name?: string | null
          default_buyer_premium_bps?: number | null
          id?: string | null
          logo_url?: string | null
          offers_pickup?: boolean | null
          offers_shipping?: boolean | null
          slug?: string | null
          status?: Database["public"]["Enums"]["operator_status"] | null
        }
        Relationships: []
      }
      stuck_webhook_claims: {
        Row: {
          event_type: string | null
          stripe_event_id: string | null
        }
        Insert: {
          event_type?: string | null
          stripe_event_id?: string | null
        }
        Update: {
          event_type?: string | null
          stripe_event_id?: string | null
        }
        Relationships: []
      }
      walk_progress_per_warehouse: {
        Row: {
          landmarks: number | null
          last_walk_at: string | null
          operator_id: string | null
          positioned_bins: number | null
          total_bins: number | null
          verified_bins: number | null
          warehouse_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "warehouses_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operator_billing_mtd"
            referencedColumns: ["operator_id"]
          },
          {
            foreignKeyName: "warehouses_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warehouses_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators_public"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _ensure_operator_bidder_relation: {
        Args: { p_bidder_id: string; p_operator_id: string }
        Returns: undefined
      }
      _find_lot_by_scan: { Args: { p_candidates: string[] }; Returns: Json }
      _normalize_scan_candidates: {
        Args: { p_scan: string }
        Returns: string[]
      }
      add_warehouse_landmark: {
        Args: {
          p_coord_x_m: number
          p_coord_y_m: number
          p_kind: string
          p_name: string
          p_scan_pose?: Json
          p_warehouse_id: string
        }
        Returns: {
          coord_x_m: number
          coord_y_m: number
          created_at: string
          id: string
          kind: string | null
          name: string
          scan_pose: Json | null
          scanned_at: string
          updated_at: string
          warehouse_id: string
        }
        SetofOptions: {
          from: "*"
          to: "warehouse_landmarks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      advance_auction_lifecycle: { Args: never; Returns: Json }
      apply_relot_fee: {
        Args: { p_amount_cents?: number; p_invoice_id: string }
        Returns: number
      }
      archive_load: { Args: { p_load_id: string }; Returns: boolean }
      assign_lot_to_bin: {
        Args: {
          p_bin_qr_token: string
          p_lot_id: string
          p_notes?: string
          p_photo_url?: string
        }
        Returns: Database["public"]["CompositeTypes"]["assign_lot_result"]
        SetofOptions: {
          from: "*"
          to: "assign_lot_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      assign_lots_to_auction: {
        Args: { p_auction_id: string; p_lot_ids: string[] }
        Returns: {
          close_at: string
          lot_code: string
          lot_id: string
          lot_number: number
        }[]
      }
      auto_mark_pickup_no_show: { Args: never; Returns: Json }
      auto_pick_featured_images: {
        Args: {
          p_auction_id: string
          p_exclude_urls?: string[]
          p_limit?: number
        }
        Returns: string[]
      }
      auto_relist_unsold_lots: { Args: never; Returns: Json }
      batch_intake_lot_to_bin: {
        Args: { p_bin_qr_token: string; p_lot_identifiers: string[] }
        Returns: {
          bin_code: string
          code: string
          error: string
          from_bin_code: string
          identifier: string
          lot_code: string
          lot_id: string
          ok: boolean
          sticker_code: string
        }[]
      }
      bidder_confirm_customer_pickup: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      bidder_has_warehouse_access: {
        Args: { p_warehouse_id: string }
        Returns: boolean
      }
      build_invoices_for_auction: {
        Args: { p_auction_id: string }
        Returns: number
      }
      bulk_assign_lot_numbers: {
        Args: {
          p_auction_id: string
          p_close_at: string
          p_first_number: number
          p_lot_ids: string[]
          p_operator_id: string
          p_status: string
        }
        Returns: number
      }
      bulk_import_lots: {
        Args: {
          p_batch_source: string
          p_column_mapping: Json
          p_filename: string
          p_initial_status?: Database["public"]["Enums"]["lot_status"]
          p_operator_id_override?: string
          p_preserve_legacy?: boolean
          p_rows: Json
          p_use_provided_lot_code?: boolean
          p_warehouse_id?: string
        }
        Returns: {
          batch_id: string
          inserted_count: number
          ok: boolean
          reason: string
          skipped_count: number
        }[]
      }
      buy_dutch: {
        Args: { p_lot_id: string; p_max_acceptable_cents: number }
        Returns: Database["public"]["CompositeTypes"]["buy_result"]
        SetofOptions: {
          from: "*"
          to: "buy_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      buy_flat_price: {
        Args: { p_lot_id: string }
        Returns: Database["public"]["CompositeTypes"]["buy_result"]
        SetofOptions: {
          from: "*"
          to: "buy_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_auction: {
        Args: { p_auction_id: string; p_reason?: string }
        Returns: Json
      }
      check_operator_ai_budget: {
        Args: { p_anticipated_cost_cents?: number; p_operator_id: string }
        Returns: {
          allowed: boolean
          billed_cost_mtd_cents: number
          budget_cents: number
          markup_bps: number
          pct_used: number
          raw_cost_mtd_cents: number
        }[]
      }
      claim_prestickered_qr: {
        Args: { p_lot_id: string; p_qr_token: string }
        Returns: Json
      }
      claim_refund_job: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: {
          amount_cents: number
          attempts: number
          created_at: string
          created_by: string | null
          id: string
          invoice_id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          lot_id: string | null
          operator_id: string
          processed_at: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          reason_note: string | null
          status: string
          stripe_refund_id: string | null
          sub_reason: Database["public"]["Enums"]["refund_reason"] | null
        }[]
        SetofOptions: {
          from: "*"
          to: "refund_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_sticker_code: {
        Args: {
          p_lot_id: string
          p_raw_code: string
          p_override_barcode_guard?: boolean
        }
        Returns: Json
      }
      claim_webhook_event: {
        Args: { p_event_id: string; p_event_type: string }
        Returns: string
      }
      clear_force_password_rotate: { Args: never; Returns: Json }
      clear_paid_relot_fees: {
        Args: { p_payment_intent_id: string }
        Returns: number
      }
      commit_webhook_event: { Args: { p_event_id: string }; Returns: undefined }
      compute_application_fee_cents: {
        Args: { p_operator_id: string; p_sale_amount_cents: number }
        Returns: number
      }
      compute_dutch_current_price: {
        Args: { p_at?: string; p_lot_id: string }
        Returns: number
      }
      confirm_move_lot_to_bin: {
        Args: { p_bin_qr_token: string; p_lot_id: string }
        Returns: Database["public"]["CompositeTypes"]["intake_lot_result"]
        SetofOptions: {
          from: "*"
          to: "intake_lot_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      confirm_pickup:
        | {
            Args: { p_bin_qr_token: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.confirm_pickup(p_bin_qr_token => text), public.confirm_pickup(p_bin_qr_token => uuid). Try renaming the parameters or the function itself in the database so function overloading can be resolved"[]
          }
        | {
            Args: { p_bin_qr_token: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.confirm_pickup(p_bin_qr_token => text), public.confirm_pickup(p_bin_qr_token => uuid). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
            SetofOptions: {
              from: "*"
              to: "confirm_pickup_result"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      create_bins_bulk: {
        Args: {
          p_aisle: string
          p_bays: string
          p_levels?: string
          p_positions?: string
          p_warehouse_id: string
        }
        Returns: {
          code: string
          error: string
          ok: boolean
        }[]
      }
      create_draft_lot: {
        Args: {
          p_asin?: string
          p_brand?: string
          p_category: string
          p_category_id: string
          p_client_token?: string
          p_condition: Database["public"]["Enums"]["lot_condition"]
          p_description: string
          p_external_code: string
          p_fnsku?: string
          p_import_row_id?: string
          p_lpn?: string
          p_manufacture_sku?: string
          p_model?: string
          p_msrp_cents: number
          p_operator_id: string
          p_photo_urls: string[]
          p_product_sku?: string
          p_site_sku?: string
          p_source: string
          p_starting_bid_cents: number
          p_title: string
          p_vendor?: string
        }
        Returns: {
          out_id: string
          out_lot_code: string
        }[]
      }
      create_manual_load: {
        Args: {
          p_notes?: string
          p_purchase_cost_cents?: number
          p_purchase_date?: string
          p_source_name: string
        }
        Returns: string
      }
      current_operator_id: { Args: never; Returns: string }
      current_operator_role: {
        Args: never
        Returns: Database["public"]["Enums"]["operator_user_role"]
      }
      delete_my_account: { Args: never; Returns: Json }
      drain_build_invoice_jobs: {
        Args: { p_batch_size?: number }
        Returns: number
      }
      drop_import_rows: {
        Args: { p_import_row_ids: string[]; p_reason?: string }
        Returns: number
      }
      enqueue_notification: {
        Args: {
          p_idempotency_key?: string
          p_kind: Database["public"]["Enums"]["notification_kind"]
          p_payload: Json
          p_target_user_id: string
        }
        Returns: string
      }
      enrich_brands_batch: {
        Args: { p_batch_size?: number; p_table: string }
        Returns: number
      }
      ensure_pickup_row: { Args: { p_invoice_id: string }; Returns: string }
      extract_brand: { Args: { p_title: string }; Returns: string }
      finalize_due_lots: { Args: { p_batch_size?: number }; Returns: Json }
      finalize_lot: {
        Args: { p_lot_id: string }
        Returns: Database["public"]["CompositeTypes"]["finalize_lot_result"]
        SetofOptions: {
          from: "*"
          to: "finalize_lot_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalize_scheduled_no_bid_lots: {
        Args: { p_batch_size?: number }
        Returns: Json
      }
      find_import_row_by_scan:
        | { Args: { p_candidates: string[] }; Returns: Json }
        | { Args: { p_candidates: string[]; p_kind: string }; Returns: Json }
      find_import_row_by_tracking: {
        Args: { p_tracking: string }
        Returns: Json
      }
      find_lots_by_identifier: {
        Args: { p_identifier: string; p_kind?: string }
        Returns: {
          auction_id: string
          close_at: string
          current_bid_cents: number
          id: string
          lot_code: string
          photo_urls: string[]
          starting_bid_cents: number
          status: string
          title: string
        }[]
      }
      get_active_operator_policy: {
        Args: { p_operator_id: string }
        Returns: {
          effective_at: string
          operator_id: string
          payment_window_hours: number
          pickup_window_days: number
          refund_md: string
          refund_window_post_pickup_hours: number
          shipping_md: string
          shipping_offered: boolean
          terms_md: string
          version: number
        }[]
      }
      get_active_policy_versions: {
        Args: never
        Returns: {
          effective_at: string
          slug: string
          version: number
        }[]
      }
      get_lot_recent_bids: {
        Args: { p_limit?: number; p_lot_id: string }
        Returns: {
          amount_cents: number
          bidder_anon: string
          is_you: boolean
          placed_at: string
        }[]
      }
      get_pickup_slots: {
        Args: { p_invoice_id: string }
        Returns: Database["public"]["CompositeTypes"]["pickup_slot"][]
        SetofOptions: {
          from: "*"
          to: "pickup_slot"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_recent_wins: {
        Args: { p_days?: number; p_limit?: number }
        Returns: {
          invoice_id: string
          lot_count: number
          paid_at: string
          representative_photo_url: string
          representative_title: string
          savings_cents: number
        }[]
      }
      health_check_pg_cron_failures: { Args: never; Returns: number }
      intake_lot_to_bin: {
        Args: { p_bin_qr_token: string; p_lot_identifier: string }
        Returns: Database["public"]["CompositeTypes"]["intake_lot_result"]
        SetofOptions: {
          from: "*"
          to: "intake_lot_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      is_bidder: { Args: never; Returns: boolean }
      is_fake_asin: { Args: { p_asin: string }; Returns: boolean }
      is_fake_upc: { Args: { p_digits: string }; Returns: boolean }
      is_safe_image_url: { Args: { p_url: string }; Returns: boolean }
      is_subscriber: { Args: { p_operator_id?: string }; Returns: boolean }
      loads_with_lot_counts: {
        Args: never
        Returns: {
          load_id: string
          lot_count: number
        }[]
      }
      lookup_product_by_code: {
        Args: { p_code: string }
        Returns: {
          asin: string | null
          avg_asking_cents: number | null
          brand: string | null
          category_id: string | null
          category_raw: string | null
          confidence: string
          created_at: string
          description: string | null
          external_codes: string[]
          fnsku: string | null
          identity_refreshed_at: string
          image_urls: string[]
          lpn: string | null
          median_sold_cents: number | null
          model: string | null
          mpn: string | null
          msrp_cents: number | null
          prices: Json
          prices_refreshed_at: string | null
          sold_comps: Json
          sources: string[]
          specs: string | null
          start_bid_cents: number | null
          title: string | null
          upc: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "product_lookups"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      lot_from_manifest: { Args: { p_identifier: string }; Returns: Json }
      mark_import_row_lotted: {
        Args: { p_import_row_id: string; p_lot_id: string }
        Returns: Json
      }
      mark_invite_consumed: {
        Args: { p_invite_id: string; p_operator_id: string }
        Returns: undefined
      }
      mark_lot_disposed: {
        Args: { p_lot_id: string; p_reason?: string }
        Returns: Json
      }
      mark_settlements_releasable: { Args: never; Returns: number }
      min_bid_increment_cents: {
        Args: { current_cents: number; schedule?: Json }
        Returns: number
      }
      mint_blank_qr_batch: {
        Args: { p_count?: number }
        Returns: {
          batch_id: string
          qr_tokens: string[]
        }[]
      }
      mint_invite_direct: {
        Args: {
          p_business_name_hint?: string
          p_email: string
          p_notes?: string
          p_ttl_days?: number
        }
        Returns: {
          email: string
          expires_at: string
          invite_id: string
          token: string
        }[]
      }
      mint_operator_invite: {
        Args: { p_notes?: string; p_request_id: string; p_ttl_days?: number }
        Returns: {
          business_name: string
          email: string
          expires_at: string
          invite_id: string
          token: string
        }[]
      }
      move_bin_contents: {
        Args: { p_from_bin: string; p_to_bin: string }
        Returns: number
      }
      my_active_pro_plan: {
        Args: { p_operator_id: string }
        Returns: {
          active: boolean
          created_at: string
          extended_pickup_days: number
          extra_grace_hours: number
          id: string
          name: string
          operator_id: string
          price_cents: number
          staging_prep: boolean
          stripe_price_id: string | null
          stripe_product_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "operator_pro_plans"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      next_lot_code: { Args: { p_operator_id: string }; Returns: string }
      normalize_brand: { Args: { p_raw: string }; Returns: string }
      normalize_manifest_condition: {
        Args: { p_raw: string }
        Returns: Database["public"]["Enums"]["lot_condition"]
      }
      normalize_upc: { Args: { p_raw: string }; Returns: string }
      open_due_lots: { Args: { p_batch_size?: number }; Returns: Json }
      operator_bidder_location_summary: {
        Args: {
          p_from: string
          p_to: string
          p_warehouse_id?: string
          p_zip_prefix?: string
        }
        Returns: {
          active_bidders: number
          buyers: number
          paid_invoices: number
          postal_code: string
          registered: number
          sales_net_cents: number
          warehouse_id: string | null
          warehouse_name: string
        }[]
      }
      operator_bidder_location_summary_by_place: {
        Args: {
          p_city?: string
          p_from: string
          p_state?: string
          p_to: string
          p_warehouse_id?: string
          p_zip_prefix?: string
        }
        Returns: {
          active_bidders: number
          buyers: number
          city: string | null
          paid_invoices: number
          postal_code: string
          registered: number
          sales_net_cents: number
          state: string | null
          warehouse_id: string | null
          warehouse_name: string
        }[]
      }
      operator_bidder_places: {
        Args: never
        Returns: { city: string | null; registered: number; state: string }[]
      }
      operator_bidder_zip_coverage: {
        Args: never
        Returns: { registered: number; with_zip: number }[]
      }
      operator_role_can: { Args: { p_capability: string }; Returns: boolean }
      parse_dollars_to_cents: { Args: { p_raw: string }; Returns: number }
      parse_int_range: { Args: { p_spec: string }; Returns: number[] }
      payments_disabled: { Args: never; Returns: boolean }
      public_warehouse_pickup_info: {
        Args: { p_warehouse_id: string }
        Returns: {
          id: string
          name: string
          address_line1: string | null
          address_line2: string | null
          city: string | null
          state: string | null
          postal_code: string | null
          timezone: string | null
          pickup_hours: Json | null
          pickup_instructions: string | null
          customer_notice: string | null
        }[]
      }
      place_bid: {
        Args: { p_lot_id: string; p_max_amount_cents: number }
        Returns: Database["public"]["CompositeTypes"]["place_bid_result"]
        SetofOptions: {
          from: "*"
          to: "place_bid_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      publish_warehouse_floor_plan: {
        Args: { p_warehouse_id: string }
        Returns: Json
      }
      record_consent: {
        Args: { p_consent_method: string; p_slug: string; p_version: number }
        Returns: string
      }
      record_operator_consent: {
        Args: { p_operator_id: string; p_version: number }
        Returns: string
      }
      redeem_operator_invite: {
        Args: { p_signup_email: string; p_token: string }
        Returns: {
          business_name_hint: string
          invite_id: string
        }[]
      }
      redistribute_close_times: {
        Args: { p_auction_id: string }
        Returns: number
      }
      relist_lot_into_auction: {
        Args: { p_auction_id: string; p_lot_id: string }
        Returns: string
      }
      reorder_auction_lots: {
        Args: { p_auction_id: string; p_ordered_ids: string[] }
        Returns: number
      }
      reserve_lot_number_range: {
        Args: { p_auction_id: string; p_count: number }
        Returns: number
      }
      reserve_next_lot_number: {
        Args: { p_auction_id: string }
        Returns: number
      }
      resolve_category_id: { Args: { p_text: string }; Returns: string }
      resolve_category_ids_batch: {
        Args: { p_texts: string[] }
        Returns: {
          category_id: string
          input_idx: number
        }[]
      }
      resolve_lot_by_qr_token: {
        Args: { p_token: string }
        Returns: {
          auction_id: string
          auction_status: string
          lot_code: string
          lot_id: string
          operator_code: string
          operator_id: string
          status: Database["public"]["Enums"]["lot_status"]
          thumbnail_url: string
          title: string
        }[]
      }
      resolve_lot_by_sticker: {
        Args: { p_operator_id: string; p_raw_code: string }
        Returns: {
          auction_id: string
          auction_status: string
          lot_code: string
          lot_id: string
          operator_code: string
          operator_id: string
          status: Database["public"]["Enums"]["lot_status"]
          thumbnail_url: string
          title: string
        }[]
      }
      revoke_bin_token: {
        Args: { p_bin_id: string; p_reason?: string }
        Returns: undefined
      }
      rotate_bin_token: { Args: { p_bin_id: string }; Returns: string }
      rotate_lot_qr: {
        Args: { p_lot_id: string }
        Returns: {
          new_qr_token: string
          rotated_at: string
        }[]
      }
      schedule_pickup: {
        Args: { p_invoice_id: string; p_slot_starts_at: string }
        Returns: Database["public"]["CompositeTypes"]["schedule_pickup_result"]
        SetofOptions: {
          from: "*"
          to: "schedule_pickup_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_bidder_preview_operator: {
        Args: { p_auction_id: string }
        Returns: Json
      }
      set_invoice_fulfillment: {
        Args: {
          p_easypost_rate_id?: string
          p_easypost_shipment_id?: string
          p_invoice_id: string
          p_method: string
          p_shipping_addr: Json
          p_shipping_cents: number
        }
        Returns: Json
      }
      set_my_postal_code: { Args: { p_postal_code: string }; Returns: undefined }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      snooze_my_postal_code_prompt: { Args: never; Returns: undefined }
      staff_confirm_pickup: {
        Args: {
          p_allow_incomplete?: boolean
          p_invoice_id: string
          p_lot_codes: string[]
        }
        Returns: Database["public"]["CompositeTypes"]["staff_confirm_pickup_result"]
        SetofOptions: {
          from: "*"
          to: "staff_confirm_pickup_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      staff_scan_bidder_token: { Args: { p_token: string }; Returns: Json }
      staff_search_bidder_invoices: {
        Args: { p_query: string }
        Returns: {
          bidder_id: string
          created_at: string
          display_name: string
          email: string
          invoice_id: string
          status: string
          total_cents: number
        }[]
      }
      stamp_admin_first_seen: { Args: never; Returns: Json }
      stamp_bin_walk_position: {
        Args: {
          p_bin_id: string
          p_coord_x_m: number
          p_coord_y_m: number
          p_scan_pose?: Json
        }
        Returns: {
          aisle: string
          bay: string | null
          code: string
          coord_x_m: number | null
          coord_y_m: number | null
          created_at: string
          floor_plan_version_placed: number | null
          id: string
          is_active: boolean
          landmark_photo_taken_at: string | null
          landmark_photo_url: string | null
          level: number | null
          position: number | null
          qr_revoked_at: string | null
          qr_revoked_by: string | null
          qr_revoked_reason: string | null
          qr_rotated_at: string | null
          qr_token: string
          retired_at: string | null
          scan_pose: Json | null
          scanned_at: string | null
          section: string | null
          updated_at: string
          warehouse_id: string
          x_px: number
          y_px: number
        }
        SetofOptions: {
          from: "*"
          to: "bins"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_competitor_lots_batch: { Args: { p_rows: Json }; Returns: Json }
    }
    Enums: {
      auction_format: "standard" | "dutch" | "last_chance"
      auction_status: "draft" | "scheduled" | "live" | "closed" | "canceled"
      bin_assignment_status: "staged" | "picked_up" | "returned_to_floor"
      dispute_status: "open" | "resolved" | "denied"
      invoice_fulfillment_method: "pickup" | "ship"
      invoice_status:
        | "pending"
        | "paid"
        | "refunded"
        | "partially_refunded"
        | "canceled"
        | "unpaid_no_show"
        | "payment_failed_grace"
        | "payment_failed_relisted"
      lot_condition: "appears_new" | "open_box" | "good" | "as_is"
      lot_status:
        | "draft"
        | "scheduled"
        | "live"
        | "won"
        | "unsold"
        | "canceled"
        | "relisted"
        | "pending_intake"
        | "in_inventory"
        | "disposed"
      notification_kind:
        | "outbid"
        | "won"
        | "pickup_ready"
        | "pickup_confirmed"
        | "dispute_update"
        | "closing_soon"
        | "saved_search_hit"
        | "payment_failed"
        | "payment_retry_reminder"
        | "dispute_opened"
        | "dispute_evidence_due"
        | "lot_relisted_no_show"
        | "ai_budget_50"
        | "ai_budget_80"
        | "ai_budget_100"
        | "payment_requires_action"
        | "relot_fee_applied"
        | "pickup_no_show_forfeit"
        | "pickup_no_show_refund_pending"
        | "refund_completed"
        | "refund_failed"
        | "payment_succeeded"
        | "pickup_reminder"
      operator_status:
        | "pending"
        | "active"
        | "suspended"
        | "subscription_lapsed"
      operator_user_role: "admin" | "manager" | "picker" | "lead"
      pickup_status:
        | "pending"
        | "scheduled"
        | "completed"
        | "no_show"
        | "forfeited"
      refund_reason:
        | "no_show_refund_minus_restock"
        | "admin_partial_refund"
        | "admin_full_refund"
        | "defective_item"
        | "wrong_item"
        | "damaged_in_transit"
        | "other"
      settlement_status: "held" | "releasable" | "transferred" | "voided"
      subscription_status:
        | "none"
        | "trialing"
        | "active"
        | "past_due"
        | "canceled"
    }
    CompositeTypes: {
      assign_lot_result: {
        ok: boolean | null
        reason: string | null
        assignment_id: string | null
        bin_id: string | null
        bin_code: string | null
      }
      buy_result: {
        ok: boolean | null
        reason: string | null
        lot_id: string | null
        final_price_cents: number | null
      }
      confirm_pickup_result: {
        ok: boolean | null
        reason: string | null
        picked_up_count: number | null
        bin_id: string | null
        bin_code: string | null
        lot_ids: string[] | null
      }
      finalize_lot_result: {
        ok: boolean | null
        reason: string | null
        lot_id: string | null
        status: Database["public"]["Enums"]["lot_status"] | null
        close_at: string | null
        winner_bidder_id: string | null
        winning_bid_cents: number | null
      }
      intake_lot_result: {
        ok: boolean | null
        reason: string | null
        lot_id: string | null
        lot_code: string | null
        bin_code: string | null
        warehouse_id: string | null
        from_bin_code: string | null
      }
      pickup_slot: {
        starts_at: string | null
        ends_at: string | null
        remaining_capacity: number | null
      }
      place_bid_result: {
        ok: boolean | null
        reason: string | null
        lot_id: string | null
        current_bid_cents: number | null
        current_leader_id: string | null
        close_at: string | null
        was_extended: boolean | null
        outbid_bidder_id: string | null
      }
      schedule_pickup_result: {
        ok: boolean | null
        reason: string | null
        pickup_id: string | null
        scheduled_at: string | null
      }
      staff_confirm_pickup_result: {
        out_pickup_id: string | null
        out_lots_picked_count: number | null
        out_warning: string | null
        out_missing_lot_codes: string[] | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      auction_format: ["standard", "dutch", "last_chance"],
      auction_status: ["draft", "scheduled", "live", "closed", "canceled"],
      bin_assignment_status: ["staged", "picked_up", "returned_to_floor"],
      dispute_status: ["open", "resolved", "denied"],
      invoice_fulfillment_method: ["pickup", "ship"],
      invoice_status: [
        "pending",
        "paid",
        "refunded",
        "partially_refunded",
        "canceled",
        "unpaid_no_show",
        "payment_failed_grace",
        "payment_failed_relisted",
      ],
      lot_condition: ["appears_new", "open_box", "good", "as_is"],
      lot_status: [
        "draft",
        "scheduled",
        "live",
        "won",
        "unsold",
        "canceled",
        "relisted",
        "pending_intake",
        "in_inventory",
        "disposed",
      ],
      notification_kind: [
        "outbid",
        "won",
        "pickup_ready",
        "pickup_confirmed",
        "dispute_update",
        "closing_soon",
        "saved_search_hit",
        "payment_failed",
        "payment_retry_reminder",
        "dispute_opened",
        "dispute_evidence_due",
        "lot_relisted_no_show",
        "ai_budget_50",
        "ai_budget_80",
        "ai_budget_100",
        "payment_requires_action",
        "relot_fee_applied",
        "pickup_no_show_forfeit",
        "pickup_no_show_refund_pending",
        "refund_completed",
        "refund_failed",
        "payment_succeeded",
        "pickup_reminder",
      ],
      operator_status: [
        "pending",
        "active",
        "suspended",
        "subscription_lapsed",
      ],
      operator_user_role: ["admin", "manager", "picker", "lead"],
      pickup_status: [
        "pending",
        "scheduled",
        "completed",
        "no_show",
        "forfeited",
      ],
      refund_reason: [
        "no_show_refund_minus_restock",
        "admin_partial_refund",
        "admin_full_refund",
        "defective_item",
        "wrong_item",
        "damaged_in_transit",
        "other",
      ],
      settlement_status: ["held", "releasable", "transferred", "voided"],
      subscription_status: [
        "none",
        "trialing",
        "active",
        "past_due",
        "canceled",
      ],
    },
  },
} as const
